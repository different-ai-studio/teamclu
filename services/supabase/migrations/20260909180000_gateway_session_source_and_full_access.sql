-- Channel (gateway) sessions should be marked source='gateway', not the
-- default 'user'. Desktop permission UI and RuntimeStart treat unattended
-- origins as full access; without the stamp those sessions looked like
-- ordinary chats and stayed on "ask" / 默认权限.
--
-- Cron rows that reach ensure_gateway_session with a `cron/<job>/<run>`
-- binding keep source='cron'. createCronSession already inserts that value;
-- the CASE below only matters for the rare path that creates via this RPC.

-- Backfill existing channel sessions. Leave cron bindings alone.
UPDATE amux.sessions
   SET source = 'gateway'
 WHERE source = 'user'
   AND gateway_key IS NOT NULL
   AND gateway_key NOT LIKE 'cron/%';

create or replace function amux.ensure_gateway_session(
  p_team_id uuid,
  p_binding text,
  p_title text,
  p_primary_agent_actor_id uuid,
  p_owner_member_actor_ids uuid[],
  p_participant_actor_ids uuid[]
)
returns table(session_id uuid, acp_session_id text, created boolean)
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
begin
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
    -- Un-archive on inbound traffic, backfill gateway_key, and stamp source
    -- when the row still carries the historical default 'user'. Do not clobber
    -- an explicit cron/thread/user rewrite.
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

  insert into amux.session_participants (session_id, actor_id)
    select v_session, participant_actor_id
      from unnest(
        array[p_primary_agent_actor_id]
          || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
          || coalesce(p_participant_actor_ids,  '{}'::uuid[])
      ) as participant_actor_id
     where participant_actor_id is not null
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;

  return query select v_session, v_acp, v_created;
end;
$function$;
