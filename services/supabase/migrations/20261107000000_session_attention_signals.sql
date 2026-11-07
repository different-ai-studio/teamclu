-- Session attention signals: list has_mention + push-target kind/actor_id.
--
-- Desktop lights unread/@ badges from MQTT inbox pings; list rows carry
-- has_mention so a restart can rebuild the same counts from the server.
-- has_mention is only true when an unread message's mention_actor_ids contains
-- the caller's actor (mentioning someone else does not count).

-- ─── 1. list_session_push_targets: actor_id + session_kind ───────────────────
-- One extra column per recipient and one scalar on the envelope. FC already
-- calls this RPC on every message fan-out; folding kind here avoids a second
-- session lookup on the hot path.

CREATE OR REPLACE FUNCTION amux.list_session_push_targets(
  p_session_id uuid,
  p_exclude_actor_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH sender AS (
    SELECT coalesce(display_name, 'Someone') AS display_name
      FROM amux.actors WHERE id = p_exclude_actor_id
  ),
  recipients AS (
    SELECT
      a.user_id,
      a.id AS actor_id,
      coalesce(
        (SELECT jsonb_agg(jsonb_build_object(
            'provider', dpt.provider,
            'token',    dpt.token,
            'device_id', dpt.device_id))
           FROM amux.device_push_tokens dpt
          WHERE dpt.user_id = a.user_id
            AND dpt.revoked_at IS NULL),
        '[]'::jsonb
      ) AS tokens,
      coalesce(
        (SELECT to_jsonb(np)
           FROM amux.notification_prefs np
          WHERE np.user_id = a.user_id),
        jsonb_build_object('enabled', true)
      ) AS prefs,
      coalesce(
        (SELECT jsonb_agg(jsonb_build_object(
            'device_id',        cp.device_id,
            'foreground_until', cp.foreground_until))
           FROM amux.client_presence cp
          WHERE cp.user_id = a.user_id
            AND cp.foreground_until > now()),
        '[]'::jsonb
      ) AS presence,
      EXISTS(
        SELECT 1 FROM amux.session_mutes sm
         WHERE sm.user_id = a.user_id
           AND sm.session_id = p_session_id
      ) AS muted
    FROM amux.session_participants sp
    JOIN amux.actors a ON a.id = sp.actor_id
    WHERE sp.session_id = p_session_id
      AND sp.actor_id <> p_exclude_actor_id
      AND a.user_id IS NOT NULL
      AND a.actor_type = 'member'
  ),
  session_kind AS (
    SELECT CASE
      WHEN s.source = 'cron' THEN 'cron'
      WHEN s.source = 'gateway' THEN 'channel'
      WHEN s.app_id IS NOT NULL THEN 'app'
      ELSE 'regular'
    END AS kind
    FROM amux.sessions s
    WHERE s.id = p_session_id
  )
  SELECT jsonb_build_object(
    'sender_display_name', coalesce((SELECT display_name FROM sender), 'Someone'),
    'session_kind', coalesce((SELECT kind FROM session_kind), 'regular'),
    'recipients', coalesce(
       (SELECT jsonb_agg(to_jsonb(r)) FROM recipients r),
       '[]'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION amux.list_session_push_targets(uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_session_push_targets(uuid, uuid) TO service_role;

-- ─── 2. list_current_actor_sessions_v2: has_mention ──────────────────────────
-- Drop/recreate: RETURNS TABLE shape change.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
);

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
  has_mention boolean,
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
DECLARE
  v_actor_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'list_current_actor_sessions_v2 requires an authenticated member'
      USING ERRCODE = '42501';
  END IF;

  IF p_team_id IS NULL THEN
    RAISE EXCEPTION 'list_current_actor_sessions_v2 requires p_team_id'
      USING ERRCODE = '22023';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('regular', 'channel', 'app', 'cron') THEN
    RAISE EXCEPTION 'list_current_actor_sessions_v2 p_kind must be regular, channel, app, or cron'
      USING ERRCODE = '22023';
  END IF;

  IF NOT amux.is_team_member(p_team_id) THEN
    RAISE EXCEPTION 'list_current_actor_sessions_v2 requires team membership'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := amux.current_actor_id_for_team(p_team_id);
  IF v_actor_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH page AS (
    SELECT
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
      s.app_id,
      coalesce(
        (SELECT srm.last_read_at
           FROM amux.session_read_markers srm
          WHERE srm.session_id = s.id
            AND srm.actor_id = v_actor_id),
        '-infinity'::timestamptz
      ) AS last_read_at
    FROM amux.sessions s
    WHERE s.team_id = p_team_id
      AND s.archived_at IS NULL
      AND s.parent_session_id IS NULL
      AND (p_idea_id IS NULL OR s.idea_id = p_idea_id)
      AND (
        (p_kind = 'regular'
          AND coalesce(s.source, 'user') = 'user'
          AND s.app_id IS NULL)
        OR (p_kind = 'channel' AND s.source = 'gateway')
        OR (p_kind = 'app'
          AND s.app_id IS NOT NULL
          AND coalesce(s.source, 'user') NOT IN ('cron', 'gateway'))
        OR (p_kind = 'cron' AND s.source = 'cron')
      )
      AND EXISTS (
        SELECT 1
          FROM amux.session_participants sp
         WHERE sp.session_id = s.id
           AND sp.actor_id = v_actor_id
      )
      AND (
        p_before_id IS NULL
        OR (
          CASE
            WHEN p_before_last_message_at IS NULL THEN
              s.last_message_at IS NOT NULL
              OR (
                s.last_message_at IS NULL
                AND (
                  s.created_at < p_before_created_at
                  OR (s.created_at = p_before_created_at AND s.id < p_before_id)
                )
              )
            WHEN s.last_message_at IS NULL THEN false
            WHEN s.last_message_at < p_before_last_message_at THEN true
            WHEN s.last_message_at = p_before_last_message_at THEN
              s.created_at < p_before_created_at
              OR (s.created_at = p_before_created_at AND s.id < p_before_id)
            ELSE false
          END
        )
      )
    ORDER BY
      s.last_message_at DESC NULLS FIRST,
      s.created_at DESC,
      s.id DESC
    LIMIT greatest(1, least(coalesce(p_limit, 50), 101))
  )
  SELECT
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
      p.last_message_at IS NOT NULL
      AND p.last_message_at > p.last_read_at
    ) AS has_unread,
    (
      p.last_message_at IS NOT NULL
      AND p.last_message_at > p.last_read_at
      AND EXISTS (
        SELECT 1
          FROM amux.messages m
         WHERE m.session_id = p.id
           AND m.created_at > p.last_read_at
           AND (m.metadata -> 'mention_actor_ids') ? v_actor_id::text
      )
    ) AS has_mention,
    p.source,
    p.cron_job_id,
    p.summary,
    p.primary_agent_id,
    p.created_by_actor_id,
    (
      SELECT count(*)::integer
        FROM amux.session_participants participant
       WHERE participant.session_id = p.id
    ) AS participant_count,
    p.app_id
  FROM page p
  ORDER BY
    p.last_message_at DESC NULLS FIRST,
    p.created_at DESC,
    p.id DESC;
END;
$function$;

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
) TO authenticated;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions_v2(
  uuid, text, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
) TO service_role;
