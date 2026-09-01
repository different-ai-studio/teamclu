-- services/supabase/tests/001_schema_shape.sql
--
-- Every assertion here passes a description, and that is load-bearing rather
-- than cosmetic: pgTAP overloads its assertions on both (schema, object) and
-- (object, description), and two bare string literals bind to the *second*.
-- The previous version of this file was written that way throughout, so
-- `has_table('public', 'teams')` asserted a table named "public" with the
-- description "teams" -- 68 assertions that could not have caught a schema
-- change if they had ever run. See QUARANTINE.md.
--
-- agent_runtimes is gone with the ACP runtime layer, so its table, foreign key,
-- trigger and status assertions are gone with it rather than restated.
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

select plan(66);

select has_schema('amux', 'amux schema exists');

select has_table('amux', 'teams',               'teams exists');
select has_table('amux', 'actors',              'actors exists');
select has_table('amux', 'members',             'members exists');
select has_table('amux', 'team_members',        'team_members exists');
select has_table('amux', 'workspaces',          'workspaces exists');
select has_table('amux', 'agents',              'agents exists');
select has_table('amux', 'agent_member_access', 'agent_member_access exists');
select has_table('amux', 'ideas',               'ideas exists');
select has_table('amux', 'idea_activities',     'idea_activities exists');
select has_table('amux', 'idea_external_refs',  'idea_external_refs exists');
select has_table('amux', 'sessions',            'sessions exists');
select has_table('amux', 'session_participants','session_participants exists');
select has_table('amux', 'messages',            'messages exists');

select col_type_is('amux', 'actors', 'last_active_at', 'timestamp with time zone',
                   'actors.last_active_at is timestamptz');
select col_type_is('amux', 'actors', 'avatar_url', 'text',
                   'actors.avatar_url is text');

-- Uniqueness of (team_id, user_id) MUST stay partial. Agent actors carry no
-- user_id, and a team holds many of them, so a plain unique index would cap
-- every team at one agent. `indpred is not null` is what makes it partial.
select ok(
  (select indpred is not null from pg_index
    where indexrelid = 'amux.actors_team_user_idx'::regclass),
  'actors_team_user_idx is a PARTIAL unique index (many null-user actors per team)'
);
select col_type_is('amux', 'members', 'id', 'uuid',
                   'members.id is uuid');
select col_type_is('amux', 'agents', 'id', 'uuid',
                   'agents.id is uuid');
select col_type_is('amux', 'workspaces', 'agent_id', 'uuid',
                   'workspaces.agent_id is uuid');
select col_type_is('amux', 'ideas', 'sort_order', 'integer',
                   'ideas.sort_order is integer');
select col_type_is('amux', 'idea_activities', 'activity_type', 'text',
                   'idea_activities.activity_type is text');
select col_type_is('amux', 'idea_activities', 'attachment_urls', 'text[]',
                   'idea_activities.attachment_urls is text[]');

-- members and agents are subtype tables: their primary key IS the actor id.
select fk_ok('amux', 'members', 'id', 'amux', 'actors', 'id',
             'members.id references actors(id)');
select fk_ok('amux', 'agents', 'id', 'amux', 'actors', 'id',
             'agents.id references actors(id)');
select fk_ok('amux', 'workspaces', 'agent_id', 'amux', 'agents', 'id',
             'workspaces.agent_id references agents(id)');
select fk_ok('amux', 'idea_activities', 'idea_id', 'amux', 'ideas', 'id',
             'idea_activities.idea_id references ideas(id)');
select fk_ok('amux', 'sessions', 'idea_id', 'amux', 'ideas', 'id',
             'sessions.idea_id references ideas(id)');
select fk_ok('amux', 'messages', 'session_id', 'amux', 'sessions', 'id',
             'messages.session_id references sessions(id)');

select has_trigger('amux', 'members', 'enforce_members_actor_type',
                   'members enforces actor_type');
select has_trigger('amux', 'agents', 'enforce_agents_actor_type',
                   'agents enforces actor_type');
select has_trigger('amux', 'team_members', 'enforce_team_members_same_team',
                   'team_members enforces same team');
select has_trigger('amux', 'workspaces', 'enforce_workspaces_same_team',
                   'workspaces enforces same team');
select has_trigger('amux', 'actors', 'enforce_actors_parent_integrity',
                   'actors enforces parent integrity');
select has_trigger('amux', 'agents', 'enforce_agents_same_team',
                   'agents enforces same team');
select has_trigger('amux', 'agent_member_access', 'enforce_agent_member_access_same_team',
                   'agent_member_access enforces same team');
select has_trigger('amux', 'ideas', 'enforce_ideas_same_team',
                   'ideas enforces same team');
select has_trigger('amux', 'idea_activities', 'set_idea_activities_updated_at',
                   'idea_activities stamps updated_at');
select has_trigger('amux', 'workspaces', 'enforce_workspaces_parent_integrity',
                   'workspaces enforces parent integrity');
select has_trigger('amux', 'idea_external_refs', 'enforce_idea_external_refs_same_team',
                   'idea_external_refs enforces same team');
select has_trigger('amux', 'sessions', 'enforce_sessions_same_team',
                   'sessions enforces same team');
select has_trigger('amux', 'ideas', 'enforce_ideas_parent_integrity',
                   'ideas enforces parent integrity');
select has_trigger('amux', 'session_participants', 'enforce_session_participants_same_team',
                   'session_participants enforces same team');
select has_trigger('amux', 'messages', 'enforce_messages_same_team',
                   'messages enforces same team');
select has_trigger('amux', 'sessions', 'enforce_sessions_parent_integrity',
                   'sessions enforces parent integrity');

insert into amux.teams (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000001', 'team-one', 'Team One'),
  ('00000000-0000-0000-0000-000000000002', 'team-two', 'Team Two');

insert into amux.actors (id, team_id, actor_type, display_name)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', 'Subtype Member'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', 'Scoped Member');

insert into amux.members (id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'member'
);

insert into amux.workspaces (id, team_id, created_by_member_id, name)
values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'Workspace One'
);

insert into amux.actors (id, team_id, actor_type, display_name)
values (
  '10000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000002',
  'agent',
  'Scoped Agent'
);

insert into amux.agents (id, owner_member_id, status) values (
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000002',
  'active'
);

insert into amux.ideas (id, team_id, workspace_id, created_by_actor_id, title, status)
values (
  '40000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'Idea One',
  'open'
);

insert into amux.sessions (id, team_id, idea_id, created_by_actor_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'solo',
  'Session One'
);

insert into amux.sessions (id, team_id, idea_id, created_by_actor_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  null,
  '10000000-0000-0000-0000-000000000002',
  'collab',
  'Session Without Idea'
);

insert into amux.messages (id, team_id, session_id, sender_actor_id, kind, content)
values (
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'text',
  'Hello'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.actors
          set actor_type = 'agent'
          where id = '10000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'actors.actor_type update is rejected when a members row exists'
);

select ok(
  exists(
    select 1
    from amux.sessions
    where id = '50000000-0000-0000-0000-000000000002'
      and idea_id is null
  ),
  'sessions.idea_id may be null'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.actors
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '10000000-0000-0000-0000-000000000002'$sql$,
    '23514'
  ),
  'actors.team_id update is rejected when dependents exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.workspaces
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '30000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'workspaces.team_id update is rejected when dependent ideas exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.workspaces
          set agent_id = '10000000-0000-0000-0000-000000000003'
          where id = '30000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'workspaces.agent_id enforces same-team scoping'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.ideas
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '40000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'ideas.team_id update is rejected when dependent sessions exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update amux.sessions
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '50000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'sessions.team_id update is rejected when dependent messages exist'
);

-- 202604220008: workspaces unique is (team_id, agent_id, name)
do $$
declare
  v_team uuid := gen_random_uuid();
  v_agent_a uuid := gen_random_uuid();
  v_agent_b uuid := gen_random_uuid();
begin
  insert into amux.teams (id, slug, name) values (v_team, 'dup-ws', 'dup-ws');
  insert into amux.actors (id, team_id, actor_type, display_name)
    values ('10000000-0000-0000-0000-0000000000aa', v_team, 'member', 'owner'),
           (v_agent_a, v_team, 'agent', 'a'),
           (v_agent_b, v_team, 'agent', 'b');
  insert into amux.members (id, status)
    values ('10000000-0000-0000-0000-0000000000aa', 'active');
  insert into amux.team_members (team_id, member_id, role)
    values (v_team, '10000000-0000-0000-0000-0000000000aa', 'owner');
  -- agent_kind is gone; an agent row is id + owner + status now.
  insert into amux.agents (id, owner_member_id, status) values
    (v_agent_a, '10000000-0000-0000-0000-0000000000aa', 'active'),
    (v_agent_b, '10000000-0000-0000-0000-0000000000aa', 'active');

  -- Same name on two different agents in the same team must now be allowed.
  insert into amux.workspaces (team_id, agent_id, name) values (v_team, v_agent_a, 'amux');
  insert into amux.workspaces (team_id, agent_id, name) values (v_team, v_agent_b, 'amux');

  -- Duplicate on the SAME agent must still fail.
  if not pg_temp.raises_sqlstate(
    format('insert into amux.workspaces (team_id, agent_id, name) values (%L, %L, %L)',
           v_team, v_agent_a, 'amux'),
    '23505'
  ) then
    raise exception 'expected unique violation on (team_id, agent_id, name)';
  end if;
end;
$$;

select ok(
  true,
  'workspaces unique constraint is (team_id, agent_id, name)'
);

-- 202604220015: actor unified identity assertions
select col_type_is('amux', 'actors', 'user_id', 'uuid',
                   'actors.user_id is uuid');
select col_type_is('amux', 'actors', 'invited_by_actor_id', 'uuid',
                   'actors.invited_by_actor_id is uuid');
select col_is_null('amux', 'actors', 'user_id',
                   'actors.user_id is nullable');
select col_is_null('amux', 'actors', 'invited_by_actor_id',
                   'actors.invited_by_actor_id is nullable');
select fk_ok('amux', 'actors', 'invited_by_actor_id', 'amux', 'actors', 'id',
             'actors.invited_by_actor_id references actors(id)');
select has_table('amux', 'team_invites', 'team_invites exists');
select hasnt_table('amux', 'daemon_invites', 'daemon_invites is gone');
select has_view('amux', 'actor_directory', 'actor_directory view exists');
select has_column('amux', 'actor_directory', 'avatar_url',
                  'actor_directory exposes avatar_url');
select has_column('amux', 'actor_directory', 'agent_visibility',
                  'actor_directory exposes agent_visibility');
select has_function('amux', 'update_current_actor_profile', array['uuid', 'text', 'text'],
                    'update_current_actor_profile(actor, name, avatar) exists');
-- Identity is per team: the link to auth.users sits on actors, not members.
select hasnt_column('amux', 'members', 'user_id',
                    'members no longer carries user_id');
select hasnt_column('amux', 'agents', 'created_by_member_id',
                    'agents no longer carries created_by_member_id');

select * from finish();
rollback;
