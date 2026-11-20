-- Gateway session RPCs: act only on the caller's own team.
--
-- ensure_gateway_session, detach_gateway_session, attach_gateway_session and
-- list_gateway_sessions are SECURITY DEFINER (the daemon calls them as its
-- agent account, which RLS does not let reach a detached row), and none of
-- them checked which team the caller belongs to. Any signed-in user could:
--
--   * detach another team's chat session, knowing its acp_session_id, and
--     rewrite its title;
--   * attach another team's chat to one of its old sessions;
--   * create or un-archive a session in any team, with any participants;
--   * list another team's gateway sessions and their titles.
--
-- Each function now resolves the team first and requires the caller to hold an
-- actor in it (amux.is_team_member). The daemon's agent account always does:
-- it has an actor row in every team it serves, so its calls are unchanged.
--
-- A caller that is not a member gets the same answer as for a row that does
-- not exist (detached=false / attached=false / no rows), so these functions do
-- not confirm whether another team's session exists. ensure raises instead,
-- because it would otherwise create a row.
--
-- Only two kinds of caller skip the check: service_role, and a session with no
-- JWT at all (a direct database connection, such as the pgTAP fixtures). Every
-- other role must be a member, so `anon` is always refused.
--
-- detach / attach / list were also executable by PUBLIC (their migrations
-- granted `authenticated` but never revoked the default), which let `anon`
-- reach them. That grant is revoked here for all four.
--
-- Bodies are otherwise copied unchanged from
-- 20261023000000_session_participant_insert_signal.sql (ensure) and
-- 20260727030000 / 20260728000000 (detach, attach, list); belayo's live
-- definitions were checked to match them before this was written.

create or replace function amux.gateway_caller_in_team(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
  select coalesce(nullif(auth.role(), ''), 'none') in ('none', 'service_role')
      or amux.is_team_member(p_team_id);
$function$;

revoke all on function amux.gateway_caller_in_team(uuid) from public;
grant execute on function amux.gateway_caller_in_team(uuid) to authenticated, service_role;

-- ── ensure_gateway_session ───────────────────────────────────────────────────

create or replace function amux.ensure_gateway_session(
  p_team_id uuid,
  p_binding text,
  p_title text,
  p_primary_agent_actor_id uuid,
  p_owner_member_actor_ids uuid[],
  p_participant_actor_ids uuid[]
)
returns table(
  session_id uuid,
  acp_session_id text,
  created boolean,
  inserted_actor_ids uuid[]
)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
  v_source  text := case
    when p_binding like 'cron/%' then 'cron'
    else 'gateway'
  end;
  v_inserted uuid[];
begin
  if not amux.gateway_caller_in_team(p_team_id) then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  select s.id, s.acp_session_id
    into v_session, v_acp
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into amux.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, gateway_key, acp_session_id, source)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'),
       v_source)
    returning amux.sessions.id, amux.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;
  else
    update amux.sessions
       set archived_at = null,
           gateway_key = coalesce(gateway_key, p_binding),
           source = case
             when source = 'user' then v_source
             else source
           end
     where id = v_session
       and (
         archived_at is not null
         or gateway_key is null
         or source = 'user'
       );
  end if;

  with inserted as (
    insert into amux.session_participants (session_id, actor_id)
      select v_session, participant_actor_id
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as participant_actor_id
       where participant_actor_id is not null
      on conflict on constraint session_participants_session_id_actor_id_key
      do nothing
      returning actor_id
  )
  select coalesce(array_agg(actor_id), '{}'::uuid[])
    into v_inserted
    from inserted;

  return query select v_session, v_acp, v_created, v_inserted;
end;
$function$;

-- ── detach_gateway_session ───────────────────────────────────────────────────

create or replace function amux.detach_gateway_session(p_acp_session_id text)
returns table(session_id uuid, detached boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_session uuid;
  v_team    uuid;
  v_binding text;
  v_title   text;
begin
  select s.id, s.team_id, s.binding, s.title
    into v_session, v_team, v_binding, v_title
    from amux.sessions as s
   where s.acp_session_id = p_acp_session_id;

  -- Another team's session reads as unknown.
  if v_session is not null and not amux.gateway_caller_in_team(v_team) then
    return query select null::uuid, false;
    return;
  end if;

  -- Unknown id, or a session that was never bound to a gateway chat: nothing
  -- to detach. Report it rather than raising — the caller treats this as "no
  -- new session needed" and falls back to just resetting the runtime.
  if v_session is null or v_binding is null then
    return query select v_session, false;
    return;
  end if;

  update amux.sessions
     set binding = null,
         title = case
                   when coalesce(v_title, '') = '' then v_title
                   else v_title || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')'
                 end
   where id = v_session;

  return query select v_session, true;
end;
$function$;

-- ── attach_gateway_session ───────────────────────────────────────────────────

create or replace function amux.attach_gateway_session(
  p_binding text,
  p_session_id uuid
)
returns table(session_id uuid, acp_session_id text, attached boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_team    uuid;
  v_acp     text;
  v_binding text;
  v_holder  uuid;
  v_title   text;
begin
  select s.team_id, s.acp_session_id, s.binding
    into v_team, v_acp, v_binding
    from amux.sessions as s
   where s.id = p_session_id
     and s.gateway_key = p_binding;

  -- Unknown target, or another team's session: same answer.
  if v_team is null or not amux.gateway_caller_in_team(v_team) then
    return query select null::uuid, null::text, false;
    return;
  end if;

  -- Already the current session for this chat: nothing to move, and reporting
  -- it as attached keeps the command idempotent.
  if v_binding is not null and v_binding = p_binding then
    update amux.sessions set archived_at = null where id = p_session_id;
    return query select p_session_id, v_acp, true;
    return;
  end if;

  select s.id, s.title
    into v_holder, v_title
    from amux.sessions as s
   where s.team_id = v_team
     and s.binding = p_binding;

  if v_holder is not null then
    update amux.sessions
       set binding = null,
           title = case
                     when coalesce(v_title, '') = '' then v_title
                     else v_title || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')'
                   end
     where id = v_holder;
  end if;

  update amux.sessions
     set binding = p_binding,
         archived_at = null
   where id = p_session_id;

  return query select p_session_id, v_acp, true;
end;
$function$;

-- ── list_gateway_sessions ────────────────────────────────────────────────────

create or replace function amux.list_gateway_sessions(
  p_team_id uuid,
  p_gateway_key text,
  p_limit integer default 20
)
returns table(
  session_id uuid,
  acp_session_id text,
  title text,
  is_current boolean,
  last_message_at timestamp with time zone,
  created_at timestamp with time zone
)
language sql
stable
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
  select s.id,
         s.acp_session_id,
         s.title,
         (s.binding is not null and s.binding = p_gateway_key) as is_current,
         s.last_message_at,
         s.created_at
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.gateway_key = p_gateway_key
     and amux.gateway_caller_in_team(p_team_id)
   order by coalesce(s.last_message_at, s.created_at) desc, s.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

-- ── Grants: authenticated and service_role only ──────────────────────────────

revoke all on function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public, anon;
revoke all on function amux.detach_gateway_session(text) from public, anon;
revoke all on function amux.attach_gateway_session(text, uuid) from public, anon;
revoke all on function amux.list_gateway_sessions(uuid, text, integer) from public, anon;

grant execute on function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated, service_role;
grant execute on function amux.detach_gateway_session(text) to authenticated, service_role;
grant execute on function amux.attach_gateway_session(text, uuid) to authenticated, service_role;
grant execute on function amux.list_gateway_sessions(uuid, text, integer) to authenticated, service_role;
