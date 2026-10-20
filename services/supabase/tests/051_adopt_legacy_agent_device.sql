-- A pre-device-binding agent (device_id NULL) is stamped onto the machine
-- that is already running it, and nothing else is.
begin;

create or replace function pg_temp.as_member(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

do $$
declare
  v_team       uuid := gen_random_uuid();
  v_alice_uid  uuid := gen_random_uuid();
  v_bob_uid    uuid := gen_random_uuid();
  v_alice_mem  uuid := gen_random_uuid();
  v_bob_mem    uuid := gen_random_uuid();
  v_legacy     uuid := gen_random_uuid();
  v_other      uuid := gen_random_uuid();
  v_bound      uuid := gen_random_uuid();
  v_found      uuid;
  v_name       text;
  v_device     text;
  v_team_col   uuid;
  v_n          int;
  v_err_code   text;
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_alice_uid, 'alice-adopt@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_bob_uid,   'bob-adopt@amux.test',   'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false);

  insert into amux.teams (id, slug, name)
  values (v_team, 'adopt-' || left(v_team::text, 8), 'Adopt Device');

  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_alice_mem, v_team, 'member', 'Alice', v_alice_uid),
    (v_bob_mem,   v_team, 'member', 'Bob',   v_bob_uid),
    (v_legacy,    v_team, 'agent',  'UFO',   null),
    (v_other,     v_team, 'agent',  'Other', null),
    (v_bound,     v_team, 'agent',  'Bound', null);

  insert into amux.members (id, status)
  values (v_alice_mem, 'active'), (v_bob_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_alice_mem, 'owner'),
    (v_team, v_bob_mem,   'member');

  insert into amux.agents (id, status, owner_member_id)
  values
    (v_legacy, 'active', v_alice_mem),
    (v_other,  'active', v_alice_mem);

  insert into amux.agents (id, status, owner_member_id, device_id, team_id)
  values (v_bound, 'active', v_alice_mem, 'already-bound', v_team);

  perform pg_temp.as_member(v_alice_uid);

  select f.agent_id, f.display_name into v_found, v_name
    from amux.adopt_legacy_agent_device(v_team, 'device-legacy', v_legacy) f;
  if v_found is distinct from v_legacy or v_name is distinct from 'UFO' then
    raise exception 'legacy adopt returned % / %', v_found, v_name;
  end if;

  select ag.device_id, ag.team_id into v_device, v_team_col
    from amux.agents ag where ag.id = v_legacy;
  if v_device is distinct from 'device-legacy' or v_team_col is distinct from v_team then
    raise exception 'legacy row not stamped: device=% team=%', v_device, v_team_col;
  end if;

  -- Idempotent: the same pair returns the same agent and does not rename.
  select f.agent_id into v_found
    from amux.adopt_legacy_agent_device(v_team, 'device-legacy', v_legacy) f;
  if v_found is distinct from v_legacy then
    raise exception 'second adopt returned %', v_found;
  end if;

  -- A second NULL agent cannot take a device this owner already holds.
  select count(*) into v_n
    from amux.adopt_legacy_agent_device(v_team, 'device-legacy', v_other);
  if v_n <> 0 then
    raise exception 'second agent was allowed onto an occupied device';
  end if;

  -- An agent already bound to another machine stays there.
  select count(*) into v_n
    from amux.adopt_legacy_agent_device(v_team, 'device-new', v_bound);
  if v_n <> 0 then
    raise exception 'already-bound agent was moved';
  end if;
  select ag.device_id into v_device from amux.agents ag where ag.id = v_bound;
  if v_device is distinct from 'already-bound' then
    raise exception 'bound device changed to %', v_device;
  end if;

  -- Another member does not get to stamp the owner's agent.
  perform pg_temp.as_member(v_bob_uid);
  select count(*) into v_n
    from amux.adopt_legacy_agent_device(v_team, 'device-bob', v_other);
  if v_n <> 0 then
    raise exception 'non-owner stamped the agent';
  end if;

  -- find_agent_for_device now sees the stamped row for the owner.
  perform pg_temp.as_member(v_alice_uid);
  select f.agent_id into v_found
    from amux.find_agent_for_device(v_team, 'device-legacy') f;
  if v_found is distinct from v_legacy then
    raise exception 'find missed stamped agent: %', v_found;
  end if;

  begin
    perform amux.adopt_legacy_agent_device(v_team, '   ', v_legacy);
    raise exception 'blank device id was accepted';
  exception
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code <> '22023' then
        raise exception 'blank device sqlstate: got %', v_err_code;
      end if;
  end;

  raise notice 'adopt_legacy_agent_device: all assertions passed';
end;
$$;

rollback;
