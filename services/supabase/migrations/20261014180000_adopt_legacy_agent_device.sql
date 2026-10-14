-- Upgrade path for agents created before device-scoped binding.
--
-- find_agent_for_device only matches agents.device_id. Rows written by the
-- old claim/invite path (and never backfilled — see 20260812120000) have
-- device_id NULL, so a desktop upgrade classifies a machine that already
-- runs that agent as "not installed" and ensure-for-device would create a
-- second one. The server cannot pick which NULL row belongs to which
-- machine: one member can own several. The desktop sends the actor id its
-- daemon is already running as.

create or replace function amux.adopt_legacy_agent_device(
  p_team_id uuid,
  p_device_id text,
  p_agent_id uuid
) returns table(agent_id uuid, display_name text)
  language plpgsql
  security definer
  set search_path to 'amux', 'public', 'auth'
as $function$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_device text := nullif(btrim(p_device_id), '');
  v_name   text;
begin
  if v_caller is null then
    raise exception 'adopt_legacy_agent_device requires team membership'
      using errcode = '42501';
  end if;
  if v_device is null or p_agent_id is null then
    raise exception 'p_device_id and p_agent_id are required' using errcode = '22023';
  end if;

  -- Same lock as ensure_agent_for_device, so a stamp and a create cannot
  -- both claim this machine.
  perform pg_advisory_xact_lock(hashtext(p_team_id::text || ':' || v_device)::bigint);

  select a.display_name into v_name
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where ag.id = p_agent_id
     and a.team_id = p_team_id
     and a.actor_type = 'agent'
     and ag.owner_member_id = v_caller
     and ag.device_id = v_device;
  if found then
    return query select p_agent_id, v_name;
    return;
  end if;

  -- This machine is already bound to a different agent of ours. Do not
  -- move that binding, and do not attach a second row.
  if exists (
    select 1
      from amux.agents ag
     where ag.team_id = p_team_id
       and ag.device_id = v_device
       and ag.owner_member_id = v_caller
  ) then
    return;
  end if;

  update amux.agents ag
     set device_id = v_device,
         team_id = p_team_id
    from amux.actors a
   where ag.id = p_agent_id
     and a.id = ag.id
     and a.team_id = p_team_id
     and a.actor_type = 'agent'
     and ag.owner_member_id = v_caller
     and ag.device_id is null
  returning a.display_name into v_name;

  if not found then
    return;
  end if;

  return query select p_agent_id, v_name;
end;
$function$;

comment on function amux.adopt_legacy_agent_device(uuid, text, uuid) is
  'Stamp this machine''s device id onto the caller-owned agent the local daemon is already running, when that row has no device id yet. Refuses to move an agent that is already bound, or to take a device another of the caller''s agents already holds. Returns no row when the agent is not eligible.';

revoke all on function amux.adopt_legacy_agent_device(uuid, text, uuid) from public;
grant execute on function amux.adopt_legacy_agent_device(uuid, text, uuid)
  to authenticated, service_role;
