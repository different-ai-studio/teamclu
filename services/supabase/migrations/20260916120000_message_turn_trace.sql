-- Turn execution traces (#1455 §7.2): let the agent that wrote a turn-final
-- reply attach its trace pointer to that reply, and nobody else.
--
-- The daemon used to PATCH /v1/messages/:id with the whole metadata column.
-- amux.messages has no UPDATE policy, so PostgREST matched zero rows on every
-- such call and the pointer never landed. Opening UPDATE on the row would hand
-- every agent the content and metadata of its replies after the fact; instead
-- these two functions authorize exactly one write — `metadata.trace` — and
-- merge that key in SQL, so a concurrent writer's keys are never replaced by a
-- stale copy of the row.
--
-- Authorization is the INSERT policy's own rule, messages_agent_write: the
-- caller must be the agent actor the reply was sent as.

-- ── authorize_turn_trace_upload ─────────────────────────────────────────────
-- Returns the message's current trace pointer (NULL when there is none) if the
-- caller wrote the message. Otherwise raises 42501 to a session participant and
-- P0002 to anyone else — the same answer as for a message that does not exist,
-- so this cannot be used to probe which ids exist. The author is not required
-- to be a participant; authorship is the whole rule.

CREATE OR REPLACE FUNCTION amux.authorize_turn_trace_upload(
  p_team_id uuid,
  p_session_id uuid,
  p_turn_id text,
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_sender uuid;
  v_trace  jsonb;
begin
  select m.sender_actor_id, m.metadata -> 'trace'
    into v_sender, v_trace
    from amux.messages m
   where m.id = p_message_id
     and m.team_id = p_team_id
     and m.session_id = p_session_id
     and m.turn_id = p_turn_id;

  if found and v_sender is not null and amux.is_current_agent(v_sender) then
    return v_trace;
  end if;
  if found and amux.is_session_participant(p_session_id) then
    raise exception 'only the agent that wrote this reply may attach its trace'
      using errcode = '42501';
  end if;
  raise exception 'message not found' using errcode = 'P0002';
end;
$function$;

REVOKE ALL ON FUNCTION amux.authorize_turn_trace_upload(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.authorize_turn_trace_upload(uuid, uuid, text, uuid) TO authenticated;

-- ── record_turn_trace ───────────────────────────────────────────────────────
-- Set `metadata.trace` and return what is stored. A `failed` report never
-- replaces an `uploaded` pointer: the daemon reports failures best-effort and
-- one can arrive after a retry already succeeded.

CREATE OR REPLACE FUNCTION amux.record_turn_trace(
  p_team_id uuid,
  p_session_id uuid,
  p_turn_id text,
  p_message_id uuid,
  p_trace jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_trace jsonb;
begin
  if jsonb_typeof(p_trace) is distinct from 'object'
     or coalesce(p_trace ->> 'status', '') not in ('uploaded', 'failed') then
    raise exception 'trace must be an object whose status is uploaded or failed'
      using errcode = '22023';
  end if;

  -- One statement, so the downgrade guard and the merge see the same row
  -- version: the row lock makes a concurrent writer re-evaluate both.
  update amux.messages m
     set metadata = jsonb_set(
           case when jsonb_typeof(m.metadata) = 'object' then m.metadata else '{}'::jsonb end,
           '{trace}',
           p_trace,
           true)
   where m.id = p_message_id
     and m.team_id = p_team_id
     and m.session_id = p_session_id
     and m.turn_id = p_turn_id
     and amux.is_current_agent(m.sender_actor_id)
     and not (p_trace ->> 'status' = 'failed'
              and m.metadata #>> '{trace,status}' = 'uploaded')
  returning m.metadata -> 'trace' into v_trace;

  if found then
    return v_trace;
  end if;
  -- Nothing written: either the caller may not write here, which this raises,
  -- or a late failure report met an uploaded trace, which this returns.
  return amux.authorize_turn_trace_upload(p_team_id, p_session_id, p_turn_id, p_message_id);
end;
$function$;

REVOKE ALL ON FUNCTION amux.record_turn_trace(uuid, uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.record_turn_trace(uuid, uuid, text, uuid, jsonb) TO authenticated;
