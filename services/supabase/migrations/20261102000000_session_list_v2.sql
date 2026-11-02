-- Session list v2: kind-partitioned top-N RPC for GET /v2/sessions.
--
-- Leaves amux.list_current_actor_sessions untouched so /v1/sessions and iOS
-- keep their existing semantics (regular = non-cron, includes gateway/app).
--
-- v2 kinds are mutually exclusive:
--   regular  coalesce(source,'user') = 'user' AND app_id IS NULL
--   channel  source = 'gateway'
--   app      app_id IS NOT NULL AND source NOT IN ('cron','gateway')
--   cron     source = 'cron'
--
-- Shared filters: caller membership, archived_at IS NULL, parent_session_id IS NULL.
--
-- SECURITY DEFINER so the list does not pay per-row sessions/participants RLS
-- (is_session_participant cannot be inlined — see 20260810040000). Visibility
-- is enforced explicitly via team membership + EXISTS on session_participants.
--
-- Query shape: walk sessions_team_active_last_message_idx in ORDER BY order,
-- filter with EXISTS membership + kind, LIMIT the page, then compute
-- has_unread / participant_count only for returned rows.

CREATE FUNCTION amux.list_current_actor_sessions_v2(
  p_team_id uuid,
  p_kind text,
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid,
  p_idea_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamp with time zone,
  last_message_preview text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  has_unread boolean,
  source text,
  cron_job_id text,
  summary text,
  primary_agent_id uuid,
  created_by_actor_id uuid,
  participant_count integer,
  app_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth'
SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_actor_id uuid;
begin
  if auth.uid() is null then
    raise exception 'list_current_actor_sessions_v2 requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    raise exception 'list_current_actor_sessions_v2 requires p_team_id'
      using errcode = '22023';
  end if;

  if p_kind is null or p_kind not in ('regular', 'channel', 'app', 'cron') then
    raise exception 'list_current_actor_sessions_v2 p_kind must be regular, channel, app, or cron'
      using errcode = '22023';
  end if;

  if not amux.is_team_member(p_team_id) then
    raise exception 'list_current_actor_sessions_v2 requires team membership'
      using errcode = '42501';
  end if;

  v_actor_id := amux.current_actor_id_for_team(p_team_id);
  if v_actor_id is null then
    return;
  end if;

  return query
  with page as (
    select
      s.id,
      s.title,
      s.team_id,
      s.mode,
      s.idea_id,
      s.last_message_at,
      s.last_message_preview,
      s.created_at,
      s.updated_at,
      s.source,
      s.cron_job_id,
      s.summary,
      s.primary_agent_id,
      s.created_by_actor_id,
      s.app_id
    from amux.sessions s
    where s.team_id = p_team_id
      and s.archived_at is null
      and s.parent_session_id is null
      and (p_idea_id is null or s.idea_id = p_idea_id)
      and (
        (p_kind = 'regular'
          and coalesce(s.source, 'user') = 'user'
          and s.app_id is null)
        or (p_kind = 'channel' and s.source = 'gateway')
        or (p_kind = 'app'
          and s.app_id is not null
          and coalesce(s.source, 'user') not in ('cron', 'gateway'))
        or (p_kind = 'cron' and s.source = 'cron')
      )
      and exists (
        select 1
        from amux.session_participants sp
        where sp.session_id = s.id
          and sp.actor_id = v_actor_id
      )
      and (
        p_before_id is null
        or (
          case
            when p_before_last_message_at is null then
              s.last_message_at is not null
              or (
                s.last_message_at is null
                and (
                  s.created_at < p_before_created_at
                  or (s.created_at = p_before_created_at and s.id < p_before_id)
                )
              )
            when s.last_message_at is null then false
            when s.last_message_at < p_before_last_message_at then true
            when s.last_message_at = p_before_last_message_at then
              s.created_at < p_before_created_at
              or (s.created_at = p_before_created_at and s.id < p_before_id)
            else false
          end
        )
      )
    order by
      s.last_message_at desc nulls first,
      s.created_at desc,
      s.id desc
    limit greatest(1, least(coalesce(p_limit, 50), 101))
  )
  select
    p.id,
    p.title,
    p.team_id,
    p.mode,
    p.idea_id,
    p.last_message_at,
    p.last_message_preview,
    p.created_at,
    p.updated_at,
    (
      p.last_message_at is not null
      and p.last_message_at > coalesce(
            (select srm.last_read_at
               from amux.session_read_markers srm
              where srm.session_id = p.id
                and srm.actor_id = v_actor_id),
            '-infinity'::timestamptz)
    ) as has_unread,
    p.source,
    p.cron_job_id,
    p.summary,
    p.primary_agent_id,
    p.created_by_actor_id,
    (
      select count(*)::integer
      from amux.session_participants participant
      where participant.session_id = p.id
    ) as participant_count,
    p.app_id
  from page p
  order by
    p.last_message_at desc nulls first,
    p.created_at desc,
    p.id desc;
end;
$function$;

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
) TO authenticated, service_role;
