-- A bot set up in support mode works only while the support grant it was set
-- up under is live.
--
-- docs/plans/2026-11-08-platform-operator-support-access.md.
--
-- In support mode the desktop now binds the operator's machine into the
-- customer team like any other team switch: ensure_agent_for_device runs as the
-- org's support account and creates (or finds) that account's agent for the
-- machine, and the daemon claims its credentials. Those credentials belong to
-- the bot's own account, not to the support session, so nothing tied them to
-- the grant: the bot kept working after the operator left, with every role the
-- support account holds (owner, through 20261102000000).
--
-- amux.support_agents records, for each agent owned by a support account, the
-- grant it was last bound under. ensure_agent_for_device writes it on every
-- bind (an operator entering again rebinds onto the new grant), and the
-- PostgREST pre-request hook refuses the bot's requests once that grant is
-- revoked or expired, the same way it refuses the support session itself.
-- FC checks the same rule for routes that never reach PostgREST with the bot's
-- token (services/fc/src/lib/platform-operators.ts).

create table if not exists amux.support_agents (
  agent_id        uuid primary key references amux.agents (id) on delete cascade,
  support_user_id uuid not null,
  grant_id        uuid not null references amux.support_grants (id) on delete cascade,
  bound_at        timestamptz not null default now()
);

comment on table amux.support_agents is
  'Agents owned by an org''s support account, each with the support grant it was last bound under (ensure_agent_for_device). The bot may act only while that grant is live. service_role only.';

alter table amux.support_agents enable row level security;
revoke all on amux.support_agents from anon, authenticated;
grant select on amux.support_agents to service_role;

-- True unless p_user_id is the account of a support-bound agent whose grant has
-- ended. One probe of idx_actors_user_id for every other caller.
create or replace function amux.support_agent_access_live(p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux'
as $function$
  select coalesce((
    select bool_and(g.revoked_at is null and g.expires_at > now())
      from amux.actors a
      join amux.support_agents sa on sa.agent_id = a.id
      join amux.support_grants g on g.id = sa.grant_id
     where a.user_id = p_user_id
  ), true);
$function$;

comment on function amux.support_agent_access_live(uuid) is
  'False only for the account of an agent bound to a support grant (amux.support_agents) that was revoked or expired. True for every other account.';

revoke all on function amux.support_agent_access_live(uuid) from public;
grant execute on function amux.support_agent_access_live(uuid) to service_role;

-- The hook from 20261108030000, now also covering support-bound bots. Body
-- otherwise carried forward verbatim.
create or replace function amux.check_support_request()
returns void
language plpgsql
stable security definer
set search_path to 'amux'
as $function$
declare
  v_claims  jsonb;
  v_sub     text;
  v_session text;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return;  -- unparsable claims: PostgREST would not have let this through anyway
  end;
  v_sub := v_claims ->> 'sub';
  if v_sub is null or v_sub !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return;
  end if;
  if not exists (select 1 from amux.support_identities si where si.user_id = v_sub::uuid) then
    -- Not the support account itself; maybe one of its bots.
    if not amux.support_agent_access_live(v_sub::uuid) then
      raise exception 'support session ended'
        using errcode = '42501',
              hint = 'This agent was set up in a support session that has ended.';
    end if;
    return;
  end if;

  v_session := v_claims ->> 'session_id';
  if v_session is null or not exists (
       select 1 from amux.support_grants g
        where g.support_user_id = v_sub::uuid
          and g.session_id::text = v_session
          and g.revoked_at is null
          and g.expires_at > now()
     ) then
    raise exception 'support session ended'
      using errcode = '42501',
            hint = 'The support grant behind this session was ended or expired.';
  end if;
end;
$function$;

comment on function amux.check_support_request() is
  'PostgREST pre-request hook: refuses a support account whose JWT session_id has no live support grant, and the account of an agent bound to a support grant that has ended (amux.support_agents). A no-op for every other caller.';

-- Body carried forward from 20260824120000_agents_team_device_uk_add_owner.sql;
-- the only addition is the support binding after the agent is found or created.
create or replace function amux.ensure_agent_for_device(
  p_team_id uuid,
  p_device_id text,
  p_display_name text
) returns table(agent_id uuid, token text, expires_at timestamp with time zone, created boolean)
  language plpgsql
  security definer
  set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller  uuid := amux.current_actor_id_for_team(p_team_id);
  v_device  text := nullif(btrim(p_device_id), '');
  v_name    text := nullif(btrim(p_display_name), '');
  v_agent   uuid;
  v_created boolean := false;
  v_invite  record;
  v_grant   uuid;
begin
  if v_caller is null then
    raise exception 'ensure_agent_for_device requires team membership'
      using errcode = '42501';
  end if;
  if v_device is null then
    raise exception 'p_device_id is required' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'p_display_name is required' using errcode = '22023';
  end if;

  -- Serialize concurrent callers for the same machine. Two cold starts (or two
  -- windows of the same app) would otherwise both find nothing and both create
  -- an agent; the unique index would reject the loser, but only after it had
  -- minted an invite and rotated the daemon's credentials onto it.
  perform pg_advisory_xact_lock(hashtext(p_team_id::text || ':' || v_device)::bigint);

  -- Lookup no longer filters on status = 'active'. A disabled or archived
  -- agent is still the device's agent — finding it avoids a duplicate insert
  -- that the unique index (now scoped by owner_member_id) would reject.
  select ag.id into v_agent
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where a.team_id = p_team_id
     and ag.device_id = v_device
     and ag.owner_member_id = v_caller;

  if v_agent is null then
    insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values (p_team_id, 'agent', null, v_caller, v_name, null)
    returning id into v_agent;

    -- visibility is deliberately not passed: the column default ('personal') is
    -- the wanted default now that nothing asks the user. Publishing the machine
    -- to the team is an explicit later action (PATCH /v1/agents/{id}).
    insert into amux.agents (id, owner_member_id, status, device_id, team_id)
    values (v_agent, v_caller, 'active', v_device, p_team_id);

    insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
    values (v_agent, v_caller, 'admin', v_caller)
    on conflict on constraint agent_member_access_agent_id_member_id_key do update
      set permission_level = 'admin', updated_at = now();

    v_created := true;
  end if;
  -- p_display_name is create-only on purpose. The client passes a name the user
  -- typed when the machine was first bound; re-applying it on every rebind would
  -- overwrite any later rename (and the client's fallback is the hostname, so a
  -- renamed robot would silently revert on the next launch).

  -- Support mode: bind the agent to the grant behind this very session, so it
  -- stops working when that grant ends (amux.check_support_request).
  if exists (select 1 from amux.support_identities si where si.user_id = auth.uid()) then
    select g.id into v_grant
      from amux.support_grants g
     where g.support_user_id = auth.uid()
       and g.session_id::text = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')
       and g.revoked_at is null
       and g.expires_at > now();
    if v_grant is null then
      raise exception 'support session ended' using errcode = '42501';
    end if;
    insert into amux.support_agents (agent_id, support_user_id, grant_id)
    values (v_agent, auth.uid(), v_grant)
    on conflict on constraint support_agents_pkey do update
      set grant_id = excluded.grant_id, support_user_id = excluded.support_user_id, bound_at = now();
  end if;

  select * into v_invite from amux.create_team_invite(
    p_team_id         => p_team_id,
    p_kind            => 'agent',
    p_display_name    => v_name,
    p_team_role       => null,
    p_agent_kind      => 'claude',
    p_ttl_seconds     => 600,
    p_target_actor_id => v_agent
  );

  return query select v_agent, v_invite.token, v_invite.expires_at, v_created;
end;
$function$;

comment on function amux.ensure_agent_for_device(uuid, text, text) is
  'Idempotent per (team, device, owner): returns this machine''s agent in this team, creating it (visibility personal) if absent, plus a one-shot invite for the daemon to claim. An agent owned by another account is a separate row — a shared machine gets one agent per account. The lookup ignores status so a disabled/archived agent is re-bound rather than triggering a duplicate-key violation. Called by a support account, it also binds the agent to the caller''s support grant (amux.support_agents).';

grant execute on function amux.ensure_agent_for_device(uuid, text, text)
  to authenticated, service_role;

-- Support bots set up before this migration: bind each to the latest grant of
-- its support account. That grant has normally ended, so the bot stays refused
-- until an operator enters again and rebinds it.
insert into amux.support_agents (agent_id, support_user_id, grant_id)
select ag.id, si.user_id, latest.id
  from amux.agents ag
  join amux.actors owner on owner.id = ag.owner_member_id
  join amux.support_identities si on si.user_id = owner.user_id
  cross join lateral (
    select g.id from amux.support_grants g
     where g.support_user_id = si.user_id
     order by g.created_at desc
     limit 1
  ) latest
on conflict on constraint support_agents_pkey do nothing;
