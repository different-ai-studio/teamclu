-- 20261120120000_agent_inherits_owner_app_access: an active agent reaches the
-- apps its owner reaches, at its owner's level, and loses them with its owner.
begin;

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

select plan(17);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Team A:
--   creator  — member, creates a personal app
--   grantee  — member, granted write on it
--   outsider — member, no access
--   agent C  — active, owned by creator
--   agent G  — active, owned by grantee
--   agent R  — archived, owned by creator
--   agent O  — active, owned by outsider

insert into public.orgs (id, name)
values ('00000000-0000-0000-0047-0000000000f0', 'Inherit org');

insert into auth.users (id, email, aud, role, instance_id)
values
  ('00000000-0000-0000-0047-000000000101', 'inherit-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000102', 'inherit-grantee@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000103', 'inherit-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000111', 'daemon.c@amuxd.run',            'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000112', 'daemon.g@amuxd.run',            'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000113', 'daemon.r@amuxd.run',            'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0047-000000000114', 'daemon.o@amuxd.run',            'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid)
values ('00000000-0000-0000-0047-0000000000a0', 'inherit-team', 'Inherit team', '00000000-0000-0000-0047-0000000000f0');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('00000000-0000-0000-0047-000000000201', '00000000-0000-0000-0047-0000000000a0', 'member', '00000000-0000-0000-0047-000000000101', 'Creator'),
  ('00000000-0000-0000-0047-000000000202', '00000000-0000-0000-0047-0000000000a0', 'member', '00000000-0000-0000-0047-000000000102', 'Grantee'),
  ('00000000-0000-0000-0047-000000000203', '00000000-0000-0000-0047-0000000000a0', 'member', '00000000-0000-0000-0047-000000000103', 'Outsider'),
  ('00000000-0000-0000-0047-000000000211', '00000000-0000-0000-0047-0000000000a0', 'agent',  '00000000-0000-0000-0047-000000000111', 'Agent C'),
  ('00000000-0000-0000-0047-000000000212', '00000000-0000-0000-0047-0000000000a0', 'agent',  '00000000-0000-0000-0047-000000000112', 'Agent G'),
  ('00000000-0000-0000-0047-000000000213', '00000000-0000-0000-0047-0000000000a0', 'agent',  '00000000-0000-0000-0047-000000000113', 'Agent R'),
  ('00000000-0000-0000-0047-000000000214', '00000000-0000-0000-0047-0000000000a0', 'agent',  '00000000-0000-0000-0047-000000000114', 'Agent O');
insert into amux.members (id, status)
values
  ('00000000-0000-0000-0047-000000000201', 'active'),
  ('00000000-0000-0000-0047-000000000202', 'active'),
  ('00000000-0000-0000-0047-000000000203', 'active');
insert into amux.agents (id, owner_member_id, status)
values
  ('00000000-0000-0000-0047-000000000211', '00000000-0000-0000-0047-000000000201', 'active'),
  ('00000000-0000-0000-0047-000000000212', '00000000-0000-0000-0047-000000000202', 'active'),
  ('00000000-0000-0000-0047-000000000213', '00000000-0000-0000-0047-000000000201', 'archived'),
  ('00000000-0000-0000-0047-000000000214', '00000000-0000-0000-0047-000000000203', 'active');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility)
values ('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-0000000000a0',
        '00000000-0000-0000-0047-000000000201', 'Inherit app', 'inherit-app', 'static_web',
        '00000000-0000-0000-0047-0000000000f0', 'personal');
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000202', 'write',
        '00000000-0000-0000-0047-000000000201');
insert into amux.app_cron_jobs (app_id, name, schedule_expr, path)
values ('00000000-0000-0000-0047-000000000301', 'nightly', '0 0 * * *', '/cron');

-- ── the rule's set: who inherits, from whom, at what level ────────────────

select results_eq(
  $$select agent_id, owner_actor_id, permission_level
      from amux.app_inherited_agents('00000000-0000-0000-0047-000000000301')
     order by agent_id$$,
  $$values ('00000000-0000-0000-0047-000000000211'::uuid, '00000000-0000-0000-0047-000000000201'::uuid, 'admin'::text),
           ('00000000-0000-0000-0047-000000000212'::uuid, '00000000-0000-0000-0047-000000000202'::uuid, 'write'::text)$$,
  'app_inherited_agents lists the active agents of everyone with access, at their owner''s level');
select ok(not has_function_privilege('authenticated', 'amux.app_inherited_agents(uuid)', 'execute'),
          'app_inherited_agents is not callable by signed-in users (it lists other people''s agents)');
select ok(has_function_privilege('authenticated', 'amux.agent_inherited_app_level(uuid, uuid)', 'execute'),
          'agent_inherited_app_level is callable by signed-in users');

-- ── the inherited level ───────────────────────────────────────────────────

select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000211'),
          'admin', 'the creator''s agent inherits admin');
select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000212'),
          'write', 'a grantee''s agent inherits the grantee''s level');
select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000213'),
          null, 'an archived agent inherits nothing');
select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000214'),
          null, 'the agent of an owner without access inherits nothing');
select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000202'),
          null, 'a member inherits nothing (members are not agents)');

-- ── RLS as agent C (creator's) ────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0047-000000000111');
select ok(amux.caller_has_app_grant('00000000-0000-0000-0047-000000000301'),
          'caller_has_app_grant is true for the creator''s agent');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0047-000000000301'), 1,
          'the creator''s agent sees the personal app');
select is((select count(*)::int from amux.app_cron_jobs where app_id = '00000000-0000-0000-0047-000000000301'), 1,
          'the creator''s agent reads the app''s cron jobs');
select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0047-000000000301'), 0,
          'an inherited agent reads no grant rows (it holds none)');

-- ── RLS as agent G (grantee's) and agent O (outsider's) ───────────────────

reset role;
select pg_temp.as_user('00000000-0000-0000-0047-000000000112');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0047-000000000301'), 1,
          'a grantee''s agent sees the personal app');

reset role;
select pg_temp.as_user('00000000-0000-0000-0047-000000000114');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0047-000000000301'), 0,
          'the outsider''s agent does not see the personal app');

reset role;
select pg_temp.as_user('00000000-0000-0000-0047-000000000113');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0047-000000000301'), 0,
          'an archived agent does not see the personal app');

-- ── taking the owner's access away takes the agent's ──────────────────────

reset role;
delete from amux.app_member_access
 where app_id = '00000000-0000-0000-0047-000000000301'
   and member_id = '00000000-0000-0000-0047-000000000202';
select is(amux.agent_inherited_app_level('00000000-0000-0000-0047-000000000301', '00000000-0000-0000-0047-000000000212'),
          null, 'revoking the grantee drops the agent''s inherited level');

select pg_temp.as_user('00000000-0000-0000-0047-000000000112');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0047-000000000301'), 0,
          'and the agent no longer sees the app');
reset role;

select * from finish();
rollback;
