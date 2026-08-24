-- Fix: agents_team_device_uk was (team_id, device_id) — one agent per
-- team+device regardless of owner. But findAgentForDevice / findOwned both
-- filter on owner_member_id, so a device that already had an agent owned by
-- another account (shared machine, account switch) would miss the existing
-- row, try to INSERT a second one, and hit the unique constraint:
--   duplicate key value violates unique agents_team_device_uk
--
-- The design intent (documented in 20260812120000) is "one agent per account
-- per device" — a shared machine gets one agent each. The index now matches:
-- (team_id, device_id, owner_member_id).
--
-- The find RPCs also dropped the status = 'active' predicate so a disabled or
-- archived agent is found (and silently re-bound) instead of triggering a
-- duplicate insert that the index would reject.

drop index if exists amux.agents_team_device_uk;

create unique index if not exists agents_team_device_uk
  on amux.agents (team_id, device_id, owner_member_id)
  where device_id is not null;

-- ── find_agent_for_device (drop status filter) ──────────────────────────────

create or replace function amux.find_agent_for_device(
  p_team_id uuid,
  p_device_id text
) returns table(agent_id uuid, display_name text)
  language sql
  stable
  security definer
  set search_path to 'amux', 'public', 'auth'
as $function$
  select ag.id, a.display_name
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where a.team_id = p_team_id
     and ag.device_id = nullif(btrim(p_device_id), '')
     and ag.owner_member_id = amux.current_actor_id_for_team(p_team_id)
   limit 1
$function$;

comment on function amux.find_agent_for_device(uuid, text) is
  'This machine''s agent in this team, if the caller already owns one. Read-only companion to ensure_agent_for_device: the client uses it to decide whether to ask the user to name a new agent. Returns the agent regardless of status — a disabled or archived agent is still bound to this device.';

grant execute on function amux.find_agent_for_device(uuid, text)
  to authenticated, service_role;

-- ── ensure_agent_for_device (drop status filter from lookup) ─────────────────

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
  'Idempotent per (team, device, owner): returns this machine''s agent in this team, creating it (visibility personal) if absent, plus a one-shot invite for the daemon to claim. An agent owned by another account is a separate row — a shared machine gets one agent per account. The lookup ignores status so a disabled/archived agent is re-bound rather than triggering a duplicate-key violation.';

grant execute on function amux.ensure_agent_for_device(uuid, text, text)
  to authenticated, service_role;
