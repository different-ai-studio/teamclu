-- Seat changes need to know whether this call inserted a row.
-- `created` on ensure_gateway_session only says the session row is new.
-- join_session returned void, so a repeat join looked like a first join.
-- CREATE OR REPLACE cannot change a return type, so both functions are dropped
-- and recreated. Grants are reapplied to match the baseline.

drop function amux.join_session(uuid);

create function amux.join_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $$
declare
  v_team_id uuid;
  v_actor_id uuid;
  v_inserted integer;
begin
  select team_id into v_team_id from amux.sessions where id = p_session_id;
  if v_team_id is null then
    raise exception 'session not found' using errcode = 'no_data_found'; -- P0002
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);
  if v_actor_id is null then
    raise exception 'not a member of this session''s team'
      using errcode = 'insufficient_privilege'; -- 42501
  end if;

  insert into amux.session_participants (session_id, actor_id, role)
  values (p_session_id, v_actor_id, 'member')
  on conflict (session_id, actor_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function amux.join_session(uuid) from public;
grant all on function amux.join_session(uuid) to authenticated;

drop function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]);

create function amux.ensure_gateway_session(
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

revoke all on function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public;
grant all on function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to service_role;
grant all on function amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated;
