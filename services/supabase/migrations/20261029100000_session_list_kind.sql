-- Session list kinds for the sidebar filter: user / gateway / app / cron.
--
-- `source` alone cannot classify app sessions (they stay source='user' with
-- app_id set). A generated column keeps one stored value for the list RPC to
-- filter before LIMIT, without writers having to keep a second column in sync
-- when gateway sessions flip from source='user' to 'gateway'.

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS list_kind text
  GENERATED ALWAYS AS (
    CASE
      WHEN source = 'cron' THEN 'cron'
      WHEN source = 'gateway' THEN 'gateway'
      WHEN app_id IS NOT NULL THEN 'app'
      WHEN source = 'thread' THEN 'thread'
      ELSE 'user'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS sessions_team_active_list_kind_idx
  ON amux.sessions (team_id, list_kind, last_message_at DESC, created_at DESC, id DESC)
  WHERE archived_at IS NULL AND parent_session_id IS NULL;

-- Rebuild the list RPC so p_kind can select the four exclusive kinds. `regular`
-- remains as the legacy "everything except cron" page the daemon still asks
-- for; the sidebar's 会话 tab uses `user`.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  uuid, integer, timestamp with time zone, timestamp with time zone, uuid, uuid, text
);

CREATE FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid,
  p_idea_id uuid DEFAULT NULL::uuid,
  p_kind text DEFAULT 'all'
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
  app_id uuid,
  list_kind text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'app'
SET plan_cache_mode TO 'force_custom_plan'
AS $function$
begin
  if p_team_id is null then
    raise exception 'list_current_actor_sessions requires p_team_id'
      using errcode = '22023';
  end if;
  if coalesce(p_kind, 'all') not in (
    'all', 'regular', 'user', 'gateway', 'app', 'cron'
  ) then
    raise exception
      'list_current_actor_sessions p_kind must be all, regular, user, gateway, app, or cron'
      using errcode = '22023';
  end if;

  return query
  with current_actor as (
    select amux.current_actor_id_for_team(p_team_id) as actor_id
  )
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
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(
            (select srm.last_read_at
               from amux.session_read_markers srm
              where srm.session_id = s.id
                and srm.actor_id = ca.actor_id),
            '-infinity'::timestamptz)
    ) as has_unread,
    s.source,
    s.cron_job_id,
    s.summary,
    s.primary_agent_id,
    s.created_by_actor_id,
    (
      select count(*)
      from amux.session_participants participant
      where participant.session_id = s.id
    )::integer as participant_count,
    s.app_id,
    s.list_kind
  from current_actor ca
  join amux.session_participants membership
    on membership.actor_id = ca.actor_id
  join amux.sessions s
    on s.id = membership.session_id
  where s.archived_at is null
    and s.parent_session_id is null
    and s.team_id = p_team_id
    and (p_idea_id is null or s.idea_id = p_idea_id)
    and (
      coalesce(p_kind, 'all') = 'all'
      or (p_kind = 'regular' and s.list_kind <> 'cron')
      or (p_kind in ('user', 'gateway', 'app', 'cron') and s.list_kind = p_kind)
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
  limit greatest(1, least(coalesce(p_limit, 50), 101));
end;
$function$;

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions(
  uuid, integer, timestamp with time zone, timestamp with time zone, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.list_current_actor_sessions(
  uuid, integer, timestamp with time zone, timestamp with time zone, uuid, uuid, text
) TO authenticated, service_role;
