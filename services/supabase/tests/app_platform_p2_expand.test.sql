-- 20261125200000_app_platform_p2_expand: the platform's org + user identity
-- model is a complete, trigger-kept projection of the team / actor one, and
-- adding it changes nothing about the old tables.
begin;

select plan(27);

select ok(not exists (
  select 1
    from pg_roles r
    cross join (values
      ('amux.trg_apps_creator_user()'),
      ('amux.trg_apps_project()'),
      ('amux.trg_app_member_access_project()'),
      ('amux.trg_app_member_access_unproject()'),
      ('amux.trg_agents_project()'),
      ('amux.trg_actors_project()'),
      ('amux.trg_app_operator_user()')
    ) as f(signature)
   where r.rolname in ('anon', 'authenticated', 'service_role', 'teamclu_migration_runner')
     and has_function_privilege(r.oid, f.signature, 'EXECUTE')
), 'trigger-only functions do not grant EXECUTE to runtime roles or the legacy runner');

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org O, team T:
--   creator — member; grantee — member; agent C (owner: creator, connected);
--   agent U (owner: creator, no account yet)

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0062-0000000000f0', 'P2 org'),
  ('00000000-0000-0000-0062-0000000000f1', 'P2 other org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0062-000000000101', 'p2-creator@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0062-000000000102', 'p2-grantee@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0062-000000000111', 'daemon.p2c@amuxd.run',    'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0062-000000000112', 'daemon.p2u@amuxd.run',    'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid)
values ('00000000-0000-0000-0062-0000000000a0', 'p2-team', 'P2 team', '00000000-0000-0000-0062-0000000000f0');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0062-000000000201', '00000000-0000-0000-0062-0000000000a0', 'member', '00000000-0000-0000-0062-000000000101', 'Creator'),
  ('00000000-0000-0000-0062-000000000202', '00000000-0000-0000-0062-0000000000a0', 'member', '00000000-0000-0000-0062-000000000102', 'Grantee'),
  ('00000000-0000-0000-0062-000000000211', '00000000-0000-0000-0062-0000000000a0', 'agent',  '00000000-0000-0000-0062-000000000111', 'Agent C'),
  ('00000000-0000-0000-0062-000000000212', '00000000-0000-0000-0062-0000000000a0', 'agent',  null,                                     'Agent U');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0062-000000000201', 'active'),
  ('00000000-0000-0000-0062-000000000202', 'active');
insert into amux.agents (id, owner_member_id, status) values
  ('00000000-0000-0000-0062-000000000211', '00000000-0000-0000-0062-000000000201', 'active'),
  ('00000000-0000-0000-0062-000000000212', '00000000-0000-0000-0062-000000000201', 'active');

-- App 1: personal, by the creator. App 2: team-visible, by agent U (no account).
insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility) values
  ('00000000-0000-0000-0062-000000000301', '00000000-0000-0000-0062-0000000000a0',
   '00000000-0000-0000-0062-000000000201', 'P2 app', 'p2-app', 'static_web',
   '00000000-0000-0000-0062-0000000000f0', 'personal'),
  ('00000000-0000-0000-0062-000000000302', '00000000-0000-0000-0062-0000000000a0',
   '00000000-0000-0000-0062-000000000212', 'P2 agent app', 'p2-agent-app', 'static_web',
   '00000000-0000-0000-0062-0000000000f0', 'team');

-- ── the new objects ───────────────────────────────────────────────────────

select has_table('amux', 'app_links', 'app_links exists');
select has_table('amux', 'app_grants', 'app_grants exists');
select has_table('amux', 'app_delegations', 'app_delegations exists');
-- app_links and app_grants became readable, row by row, in P3.1
-- (20261127100000, app_platform_p3_read.test.sql); delegations never.
select ok(not has_table_privilege('authenticated', 'amux.app_delegations', 'select'),
          'signed-in users cannot read delegations');

-- ── creating an app projects its creator, link and visibility ─────────────

select is((select created_by_user_id from amux.apps where id = '00000000-0000-0000-0062-000000000301'),
          '00000000-0000-0000-0062-000000000101'::uuid, 'a member''s app records the member''s account');
select is((select created_by_user_id from amux.apps where id = '00000000-0000-0000-0062-000000000302'),
          '00000000-0000-0000-0062-000000000101'::uuid, 'an app by an agent with no account records its owner (Q5)');
select results_eq(
  $$select team_id, created_by_actor_id from amux.app_links where app_id = '00000000-0000-0000-0062-000000000301'$$,
  $$values ('00000000-0000-0000-0062-0000000000a0'::uuid, '00000000-0000-0000-0062-000000000201'::uuid)$$,
  'the app is linked to its team and creator actor');
select results_eq(
  $$select principal_org_id, level, source from amux.app_grants where app_id = '00000000-0000-0000-0062-000000000302'$$,
  $$values ('00000000-0000-0000-0062-0000000000f0'::uuid, 'read'::text, 'legacy'::text)$$,
  'a team-visible app gets an org read grant');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0062-000000000301'), 0,
          'a personal app with no grants has no grant rows');

-- ── visibility follows ────────────────────────────────────────────────────

update amux.apps set visibility = 'team' where id = '00000000-0000-0000-0062-000000000301';
select is((select count(*)::int from amux.app_grants
            where app_id = '00000000-0000-0000-0062-000000000301' and principal_org_id is not null), 1,
          'making an app team-visible adds the org grant');
update amux.apps set org_id = '00000000-0000-0000-0062-0000000000f1' where id = '00000000-0000-0000-0062-000000000301';
select is((select principal_org_id from amux.app_grants
            where app_id = '00000000-0000-0000-0062-000000000301' and principal_org_id is not null),
          '00000000-0000-0000-0062-0000000000f1'::uuid, 'the org grant follows the app to a new org');
update amux.apps set org_id = '00000000-0000-0000-0062-0000000000f0', visibility = 'personal'
 where id = '00000000-0000-0000-0062-000000000301';
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0062-000000000301'), 0,
          'making it personal again removes the org grant');

-- ── grants follow app_member_access ───────────────────────────────────────

insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0062-000000000301', '00000000-0000-0000-0062-000000000202', 'write',
        '00000000-0000-0000-0062-000000000201');
select results_eq(
  $$select principal_user_id, level, granted_by_user_id, source from amux.app_grants
     where app_id = '00000000-0000-0000-0062-000000000301'$$,
  $$values ('00000000-0000-0000-0062-000000000102'::uuid, 'write'::text, '00000000-0000-0000-0062-000000000101'::uuid, 'legacy'::text)$$,
  'a grant to an actor becomes a grant to its account');
update amux.app_member_access set permission_level = 'read'
 where app_id = '00000000-0000-0000-0062-000000000301' and member_id = '00000000-0000-0000-0062-000000000202';
select is((select level from amux.app_grants where app_id = '00000000-0000-0000-0062-000000000301'), 'read',
          'changing the level follows');
insert into amux.app_member_access (app_id, member_id, permission_level)
values ('00000000-0000-0000-0062-000000000301', '00000000-0000-0000-0062-000000000212', 'write');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0062-000000000301'), 1,
          'a grant to an agent with no account projects nothing');
update amux.actors set user_id = '00000000-0000-0000-0062-000000000112' where id = '00000000-0000-0000-0062-000000000212';
select is((select level from amux.app_grants
            where app_id = '00000000-0000-0000-0062-000000000301' and principal_user_id = '00000000-0000-0000-0062-000000000112'),
          'write', 'once the agent gets an account its grant appears');
delete from amux.app_member_access
 where app_id = '00000000-0000-0000-0062-000000000301' and member_id = '00000000-0000-0000-0062-000000000202';
select is((select count(*)::int from amux.app_grants
            where app_id = '00000000-0000-0000-0062-000000000301' and principal_user_id = '00000000-0000-0000-0062-000000000102'), 0,
          'revoking the grant removes its projection');

-- A native grant to the same user is never overwritten by the projection.
insert into amux.app_grants (app_id, principal_user_id, level, source)
values ('00000000-0000-0000-0062-000000000301', '00000000-0000-0000-0062-000000000102', 'admin', 'native');
insert into amux.app_member_access (app_id, member_id, permission_level)
values ('00000000-0000-0000-0062-000000000301', '00000000-0000-0000-0062-000000000202', 'read');
select results_eq(
  $$select level, source from amux.app_grants
     where app_id = '00000000-0000-0000-0062-000000000301' and principal_user_id = '00000000-0000-0000-0062-000000000102'$$,
  $$values ('admin'::text, 'native'::text)$$,
  'a native grant wins over a projected one for the same user');

-- ── delegations follow agents ─────────────────────────────────────────────

select results_eq(
  $$select delegate_user_id, principal_user_id from amux.app_delegations order by delegate_user_id$$,
  $$values ('00000000-0000-0000-0062-000000000111'::uuid, '00000000-0000-0000-0062-000000000101'::uuid),
           ('00000000-0000-0000-0062-000000000112'::uuid, '00000000-0000-0000-0062-000000000101'::uuid)$$,
  'each connected, active agent delegates to its owner');
update amux.agents set status = 'disabled' where id = '00000000-0000-0000-0062-000000000211';
select is((select count(*)::int from amux.app_delegations where source_agent_id = '00000000-0000-0000-0062-000000000211'), 0,
          'disabling the agent drops its delegation');
update amux.agents set status = 'active', owner_member_id = '00000000-0000-0000-0062-000000000202'
 where id = '00000000-0000-0000-0062-000000000211';
select is((select principal_user_id from amux.app_delegations where source_agent_id = '00000000-0000-0000-0062-000000000211'),
          '00000000-0000-0000-0062-000000000102'::uuid, 'a new owner moves the delegation');

-- ── operator columns ──────────────────────────────────────────────────────

insert into amux.app_env_vars (app_id, key, value, updated_by_member_id)
values ('00000000-0000-0000-0062-000000000301', 'P2_KEY', 'v', '00000000-0000-0000-0062-000000000201');
select is((select updated_by_user_id from amux.app_env_vars where key = 'P2_KEY'),
          '00000000-0000-0000-0062-000000000101'::uuid, 'an env var records its writer''s account');
insert into amux.app_cron_jobs (app_id, name, schedule_expr, path, created_by_member_id)
values ('00000000-0000-0000-0062-000000000301', 'p2-job', '0 0 * * *', '/cron', '00000000-0000-0000-0062-000000000201');
select is((select created_by_user_id from amux.app_cron_jobs where name = 'p2-job'),
          '00000000-0000-0000-0062-000000000101'::uuid, 'a cron job records its creator''s account');

-- ── removing things still works, and takes the projection with it ─────────

-- (agents.owner_member_id is RESTRICT: hand agent C back first)
update amux.agents set owner_member_id = '00000000-0000-0000-0062-000000000201'
 where id = '00000000-0000-0000-0062-000000000211';
delete from amux.members where id = '00000000-0000-0000-0062-000000000202';
delete from amux.actors where id = '00000000-0000-0000-0062-000000000202';
select is((select count(*)::int from amux.app_grants where legacy_member_id = '00000000-0000-0000-0062-000000000202'), 0,
          'removing an actor clears its projected grants');
select lives_ok(
  $$delete from amux.apps where team_id = '00000000-0000-0000-0062-0000000000a0';
    delete from amux.agents where owner_member_id = '00000000-0000-0000-0062-000000000201';
    delete from amux.teams where id = '00000000-0000-0000-0062-0000000000a0'$$,
  'deleting the team''s apps and the team still succeeds');
select is((select count(*)::int from amux.app_links where team_id = '00000000-0000-0000-0062-0000000000a0'), 0,
          'and leaves no links behind');

select * from finish();
rollback;
