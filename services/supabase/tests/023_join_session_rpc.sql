begin;

-- amux.join_session: a team member who is not yet a participant can self-join via
-- a share link; idempotent; outsiders and missing sessions are rejected.
-- (Post teamclu->amux move: business tables live in the amux schema.)

do $$
declare
  v_team uuid := gen_random_uuid();
  v_creator uuid := gen_random_uuid();
  v_joiner uuid := gen_random_uuid();
  v_other_team uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_missing uuid := gen_random_uuid();
  v_raised boolean;
begin
  -- Two teams. Creator + joiner in team A; outsider in team B.
  insert into auth.users (id) values (v_creator), (v_joiner), (v_outsider);
  insert into amux.teams (id, name, slug) values
    (v_team, 'Join A', 'join-a-' || v_team),
    (v_other_team, 'Join B', 'join-b-' || v_other_team);
  insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
    (v_creator, v_team, 'member', v_creator, 'creator'),
    (v_joiner, v_team, 'member', v_joiner, 'joiner'),
    (v_outsider, v_other_team, 'member', v_outsider, 'outsider');
  insert into amux.members (id, status) values
    (v_creator, 'active'),
    (v_joiner, 'active'),
    (v_outsider, 'active');
  insert into amux.team_members (team_id, member_id, role) values
    (v_team, v_creator, 'owner'),
    (v_team, v_joiner, 'member'),
    (v_other_team, v_outsider, 'owner');
  insert into amux.sessions (id, team_id, title, mode, created_by_actor_id) values
    (v_session, v_team, 'Shared', 'collab', v_creator);
  insert into amux.session_participants (session_id, actor_id) values
    (v_session, v_creator);

  -- (1) A team member (joiner) who is not yet a participant can join.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_joiner::text, 'role', 'authenticated')::text, true);
  if amux.join_session(v_session) is not true then
    raise exception 'first join should report an insert';
  end if;
  if not exists (
    select 1 from amux.session_participants
    where session_id = v_session and actor_id = v_joiner
  ) then
    raise exception 'joiner was not added as a participant';
  end if;

  -- (2) Idempotent: a second call must not create a duplicate row.
  if amux.join_session(v_session) is not false then
    raise exception 'second join should report no insert';
  end if;
  if (select count(*) from amux.session_participants
        where session_id = v_session and actor_id = v_joiner) <> 1 then
    raise exception 'join_session created a duplicate participant row';
  end if;

  -- (3) An outsider (different team) is rejected (errcode 42501).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider::text, 'role', 'authenticated')::text, true);
  v_raised := false;
  begin
    perform amux.join_session(v_session);
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'outsider was not rejected';
  end if;

  -- (4) A missing session raises no_data_found (P0002).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_joiner::text, 'role', 'authenticated')::text, true);
  v_raised := false;
  begin
    perform amux.join_session(v_missing);
  exception when no_data_found then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'missing session did not raise';
  end if;
end;
$$;

rollback;
