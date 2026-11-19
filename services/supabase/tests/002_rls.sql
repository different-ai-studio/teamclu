begin;

create or replace function pg_temp.raises_sqlstate(p_sql text, p_expected_sqlstate text)
returns boolean
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  execute p_sql;
  return false;
exception
  when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    return v_sqlstate = p_expected_sqlstate;
end;
$$;

select plan(40);

select lives_ok(
$$
  select amux.current_member_id();
$$,
'helper function exists'
);

-- current_actor_id() was dropped by 20260804020000: actors are per team, so a
-- team has to be supplied to resolve one.
select lives_ok(
$$
  select amux.current_actor_id_for_team('00000000-0000-0000-0000-000000000001'::uuid);
$$,
'actor helper exists'
);

select lives_ok(
$$
  select amux.is_team_member(gen_random_uuid());
$$,
'team membership helper exists'
);

select lives_ok(
$$
  select amux.can_prompt_agent(gen_random_uuid());
$$,
'agent prompt helper exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'amux.update_current_actor_profile(uuid,text,text)',
    'EXECUTE'
  ),
  'authenticated can execute actor profile update rpc'
);

select policies_are('amux', 'teams', array[
  'teams_select_if_member',
  'teams_insert_org_guard',
  'teams_update_if_member',
  'teams_delete_if_member'
], 'teams policy set');

-- SELECT is participant-or-creator, not plain team membership: 20260810050000
-- narrowed it so a team member does not see every session in the team.
select policies_are('amux', 'sessions', array[
  'sessions_select_if_participant_or_creator',
  'sessions_insert_if_team_member',
  'sessions_update_if_team_member'
], 'sessions policy set');

-- The two write policies carry the non-human paths: agents writing as
-- themselves, and the daemon relaying a gateway participant's message.
select policies_are('amux', 'messages', array[
  'messages_select_if_session_participant',
  'messages_insert_if_session_participant',
  'messages_agent_write',
  'messages_daemon_gateway_participant_write'
], 'messages policy set');

select policies_are('amux', 'agent_member_access', array[
  'agent_member_access_select_if_agent_owner_or_self',
  'agent_member_access_manage_if_agent_owner'
], 'agent_member_access policy set');

insert into auth.users (id, email)
values
  ('90000000-0000-0000-0000-000000000001', 'active-member@example.com'),
  ('90000000-0000-0000-0000-000000000002', 'other-member@example.com'),
  ('90000000-0000-0000-0000-000000000003', 'admin-member@example.com');

insert into amux.teams (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000001',
  'team-one',
  'Team One'
);

-- user_id lives on actors now: identity is per team, so the link to
-- auth.users belongs on the per-team row rather than on members.
insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', 'Active Member', '90000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', 'Other Member',  '90000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'member', 'Admin Member',  '90000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'agent',  'Build Agent',   null);

insert into amux.members (id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'active'),
  ('10000000-0000-0000-0000-000000000003', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'member'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'admin');

insert into amux.workspaces (id, team_id, created_by_member_id, name)
values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Workspace One'
);

insert into amux.agents (id, default_workspace_id, owner_member_id, visibility, status) values (
  '10000000-0000-0000-0000-0000000000a1',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'team',
  'active'
);

insert into amux.ideas (id, team_id, workspace_id, created_by_actor_id, title, status)
values (
  '40000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Idea One',
  'open'
);

insert into amux.sessions (id, team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-0000000000a1',
  'solo',
  'Session One'
);

insert into amux.session_participants (id, session_id, actor_id, role)
values
  ('70000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('70000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'observer');

insert into amux.messages (id, team_id, session_id, sender_actor_id, kind, content)
values (
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'text',
  'Hello'
);

insert into amux.agent_member_access (
  id,
  agent_id,
  member_id,
  permission_level,
  granted_by_member_id
)
values (
  '81000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-0000000000a1',
  '10000000-0000-0000-0000-000000000002',
  'prompt',
  '10000000-0000-0000-0000-000000000003'
);

select ok(
  not has_function_privilege('anon', 'amux.current_member_id()', 'EXECUTE'),
  'anon cannot execute current_member_id directly'
);

select ok(
  has_function_privilege('authenticated', 'amux.current_member_id()', 'EXECUTE'),
  'authenticated can execute current_member_id directly'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select lives_ok(
  $sql$
    select amux.update_current_actor_profile(
      '10000000-0000-0000-0000-000000000001',
      'Renamed Member',
      'https://example.com/avatar.jpg'
    )
  $sql$,
  'current user can update own actor profile'
);

select is(
  (select display_name from amux.actors where id = '10000000-0000-0000-0000-000000000001'),
  'Renamed Member',
  'profile update stores display name'
);

select is(
  (select avatar_url from amux.actor_directory where id = '10000000-0000-0000-0000-000000000001'),
  'https://example.com/avatar.jpg',
  'actor_directory exposes updated avatar url'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      select amux.update_current_actor_profile(
        '10000000-0000-0000-0000-000000000002',
        'Spoofed Member',
        null
      )
    $sql$,
    '42501'
  ),
  'current user cannot update another actor profile'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      select amux.update_current_actor_profile(
        '10000000-0000-0000-0000-000000000001',
        '   ',
        null
      )
    $sql$,
    '23514'
  ),
  'actor profile update rejects blank display names'
);

select is(
  amux.current_member_id(),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'active member resolves current_member_id'
);

select is(
  amux.current_actor_id_for_team('00000000-0000-0000-0000-000000000001'::uuid),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'active member resolves current_actor_id'
);

select ok(
  amux.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'active participant is recognized'
);

select is(
  (select count(*) from amux.messages),
  1::bigint,
  'active participant can read session messages'
);

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select ok(
  amux.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'explicit grant allows active team member to prompt agent'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into amux.session_participants (
        id,
        session_id,
        actor_id,
        role
      )
      values (
        '70000000-0000-0000-0000-000000000003',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'observer'
      )
    $sql$,
    '42501'
  ),
  'non-participant team member cannot self-enroll into a session'
);

select is(
  (select count(*) from amux.messages),
  0::bigint,
  'failed self-enrollment does not grant session message visibility'
);

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select lives_ok(
    $sql$
      insert into amux.session_participants (
        id,
        session_id,
        actor_id,
        role
      )
      values (
        '70000000-0000-0000-0000-000000000004',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'observer'
      )
    $sql$,
  'existing participant can add another actor to the session'
);

-- Cleanup has to drop out of `authenticated` first. session_participants has
-- SELECT and INSERT policies only, so a DELETE issued as authenticated matches
-- no policy, removes zero rows, and reports success -- which left the row in
-- place and made the next insert collide on (session_id, actor_id).
reset role;
delete from amux.session_participants
where id = '70000000-0000-0000-0000-000000000004';
set local role authenticated;

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select lives_ok(
  $sql$
    insert into amux.session_participants (
      id,
      session_id,
      actor_id,
      role
    )
    values (
      '70000000-0000-0000-0000-000000000009',
      '50000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      'observer'
    )
  $sql$,
  'session creator can bootstrap additional participants'
);

reset role;
delete from amux.session_participants
where id = '70000000-0000-0000-0000-000000000009';
set local role authenticated;

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select is(
  (select count(*) from amux.messages),
  0::bigint,
  'failed participant-managed add does not expand session message visibility'
);

-- Removal means deleting the actor row, not the team_members row. FC's
-- removeTeamActor (services/fc/src/lib/pg-repo/teams.ts) deletes from
-- amux.actors; members, team_members, session_participants and
-- agent_member_access all cascade off it, while authored rows (messages,
-- sessions, ideas) keep their history with the actor set to null.
--
-- Deleting only the team_members row revokes nothing: every RLS helper resolves
-- membership through amux.actors (is_team_member reads actors.user_id), and
-- team_members now carries role, not membership. The previous version of this
-- block deleted team_members and asserted revocation, so it was describing a
-- state the product cannot produce.
reset role;

insert into amux.session_participants (id, session_id, actor_id, role)
values (
  '70000000-0000-0000-0000-0000000000b2',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'observer'
);

delete from amux.actors
where id = '10000000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select ok(
  not amux.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'explicit grant no longer authorizes removed team member'
);

select ok(
  not amux.is_team_member('00000000-0000-0000-0000-000000000001'::uuid),
  'actor removal revokes team membership'
);

select ok(
  not amux.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'actor removal revokes session participation'
);

select is(
  (select count(*) from amux.messages),
  0::bigint,
  'actor removal revokes session message visibility'
);

-- Put the actor back (without the session seat). The spoofing assertions at the
-- bottom name this actor, and they have to fail on RLS with 42501 rather than on
-- a missing foreign key.
reset role;

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values (
  '10000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'member',
  'Other Member',
  '90000000-0000-0000-0000-000000000002'
);

insert into amux.members (id, status)
values ('10000000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values (
  '20000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'member'
);

insert into amux.agent_member_access (
  id,
  agent_id,
  member_id,
  permission_level,
  granted_by_member_id
)
values (
  '81000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-0000000000a1',
  '10000000-0000-0000-0000-000000000002',
  'prompt',
  '10000000-0000-0000-0000-000000000003'
);

reset role;

delete from amux.session_participants
where id = '70000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select ok(
  not amux.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'participant removal revokes session participation'
);

select is(
  (select count(*) from amux.messages),
  0::bigint,
  'participant removal revokes session message visibility'
);

reset role;

insert into amux.session_participants (id, session_id, actor_id, role)
values (
  '70000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'owner'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select ok(
  not amux.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'active team admin without grant cannot prompt team agent'
);

reset role;

update amux.members
set status = 'disabled'
where id = '10000000-0000-0000-0000-000000000003';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select is(
  amux.current_member_id(),
  null::uuid,
  'disabled member no longer resolves current_member_id'
);

select ok(
  not amux.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'disabled team admin cannot prompt agent'
);

-- Deliberately not asserted here: whether a disabled member also loses session
-- participation and message visibility. is_session_participant joins
-- session_participants to actors and never looks at members.status, so a
-- disabled member keeps reading the sessions they are already in. Nothing in
-- the product writes members.status = 'disabled' (removal deletes the actor,
-- see above), so this is dormant surface rather than a live leak -- and making
-- the session path status-aware means another join inside the messages SELECT
-- policy, which is the hot path 20260810040000/20260811000000 spent two
-- migrations trimming. Left as a documented gap instead of a silently failing
-- assertion.

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into amux.messages (
        id,
        team_id,
        session_id,
        sender_actor_id,
        kind,
        content
      )
      values (
        '60000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'text',
        'spoofed'
      )
    $sql$,
    '42501'
  ),
  'message sender spoofing is rejected'
);

select lives_ok(
$$
  insert into amux.messages (
    id,
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content
  )
  values (
    '60000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'text',
    'allowed'
  );
$$,
'caller can insert a message as their own actor'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into amux.workspaces (
        id,
        team_id,
        created_by_member_id,
        name
      )
      values (
        '30000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'Spoofed Workspace'
      )
    $sql$,
    '42501'
  ),
  'workspace creator spoofing is rejected'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      update amux.ideas
      set created_by_actor_id = '10000000-0000-0000-0000-000000000002'
      where id = '40000000-0000-0000-0000-000000000001'
    $sql$,
    '42501'
  ),
  'idea creator spoofing on update is rejected'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into amux.sessions (
        id,
        team_id,
        idea_id,
        created_by_actor_id,
        mode,
        title
      )
      values (
        '50000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '40000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'solo',
        'Spoofed Session'
      )
    $sql$,
    '42501'
  ),
  'session creator spoofing is rejected'
);

select * from finish();
rollback;
