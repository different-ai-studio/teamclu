-- 20261117000000_app_access_actor_grants: agents hold and give app grants, and
-- the levels are read/write/admin.
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

select plan(18);

-- ── schema ────────────────────────────────────────────────────────────────

select fk_ok('amux', 'app_member_access', 'member_id', 'amux', 'actors', 'id',
             'the grantee references actors');
select fk_ok('amux', 'app_member_access', 'granted_by_member_id', 'amux', 'actors', 'id',
             'the grantor references actors');
select has_trigger('amux', 'app_member_access', 'app_member_access_same_team',
                   'grants are kept inside the app''s team by a trigger');

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Team A: owner (member, creates the app), agent X (granted write), agent Y
-- (never granted). Team B: an agent that must not be grantable on A's app.

insert into public.orgs (id, name)
values ('00000000-0000-0000-0046-0000000000f0', 'App grant org');

insert into auth.users (id, email, aud, role, instance_id)
values
  ('00000000-0000-0000-0046-000000000101', 'grant-owner@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0046-000000000102', 'daemon.x@amuxd.run',        'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0046-000000000103', 'daemon.y@amuxd.run',        'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0046-000000000104', 'daemon.other@amuxd.run',    'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid)
values
  ('00000000-0000-0000-0046-0000000000a0', 'grant-team-a', 'Grant team A', '00000000-0000-0000-0046-0000000000f0'),
  ('00000000-0000-0000-0046-0000000000b0', 'grant-team-b', 'Grant team B', '00000000-0000-0000-0046-0000000000f0');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('00000000-0000-0000-0046-000000000201', '00000000-0000-0000-0046-0000000000a0', 'member', '00000000-0000-0000-0046-000000000101', 'Owner'),
  ('00000000-0000-0000-0046-000000000202', '00000000-0000-0000-0046-0000000000a0', 'agent',  '00000000-0000-0000-0046-000000000102', 'Agent X'),
  ('00000000-0000-0000-0046-000000000203', '00000000-0000-0000-0046-0000000000a0', 'agent',  '00000000-0000-0000-0046-000000000103', 'Agent Y'),
  ('00000000-0000-0000-0046-000000000204', '00000000-0000-0000-0046-0000000000b0', 'agent',  '00000000-0000-0000-0046-000000000104', 'Other team agent');
insert into amux.members (id, status) values ('00000000-0000-0000-0046-000000000201', 'active');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility)
values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-0000000000a0',
        '00000000-0000-0000-0046-000000000201', 'Grant app', 'grant-app', 'static_web',
        '00000000-0000-0000-0046-0000000000f0', 'personal');

insert into amux.app_cron_jobs (app_id, name, schedule_expr, path)
values ('00000000-0000-0000-0046-000000000301', 'nightly', '0 0 * * *', '/cron');

-- ── levels ────────────────────────────────────────────────────────────────

insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-000000000202', 'write',
        '00000000-0000-0000-0046-000000000201');
select pass('an agent actor can be granted write');

select throws_ok(
  $$insert into amux.app_member_access (app_id, member_id, permission_level)
    values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-000000000203', 'prompt')$$,
  '23514', null, 'the old level "prompt" is rejected');
select throws_ok(
  $$insert into amux.app_member_access (app_id, member_id, permission_level)
    values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-000000000203', 'view')$$,
  '23514', null, 'the old level "view" is rejected');

-- ── team boundary ─────────────────────────────────────────────────────────

select throws_ok(
  $$insert into amux.app_member_access (app_id, member_id, permission_level)
    values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-000000000204', 'read')$$,
  '23514', 'app grant must name an actor in the app''s team',
  'an actor from another team cannot be granted');

-- An agent that is the app's grantor: give Y read on X's behalf.
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0046-000000000301', '00000000-0000-0000-0046-000000000203', 'read',
        '00000000-0000-0000-0046-000000000202');
select is((select granted_by_member_id from amux.app_member_access
            where member_id = '00000000-0000-0000-0046-000000000203'),
          '00000000-0000-0000-0046-000000000202'::uuid,
          'an agent can be recorded as the grantor');
delete from amux.app_member_access where member_id = '00000000-0000-0000-0046-000000000203';

-- ── RLS as agent X (granted) ──────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0046-000000000102');

select ok(amux.caller_has_app_grant('00000000-0000-0000-0046-000000000301'),
          'caller_has_app_grant is true for a granted agent');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0046-000000000301'), 1,
          'a granted agent sees a personal app');
select is((select permission_level from amux.app_member_access
            where app_id = '00000000-0000-0000-0046-000000000301'), 'write',
          'a granted agent reads its own grant row');
select is((select count(*)::int from amux.app_cron_jobs where app_id = '00000000-0000-0000-0046-000000000301'), 1,
          'a granted agent reads the app''s cron jobs');

-- ── RLS as agent Y (not granted) ──────────────────────────────────────────

reset role;
select pg_temp.as_user('00000000-0000-0000-0046-000000000103');

select ok(not amux.caller_has_app_grant('00000000-0000-0000-0046-000000000301'),
          'caller_has_app_grant is false for an agent without a grant');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0046-000000000301'), 0,
          'an agent without a grant does not see a personal app');
select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0046-000000000301'), 0,
          'an agent without a grant reads no grant rows');
select is((select count(*)::int from amux.app_cron_jobs where app_id = '00000000-0000-0000-0046-000000000301'), 0,
          'an agent without a grant reads no cron jobs');

-- ── RLS as the owner ──────────────────────────────────────────────────────

reset role;
select pg_temp.as_user('00000000-0000-0000-0046-000000000101');

select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0046-000000000301'), 1,
          'the creator reads every grant on the app');

reset role;

-- ── backfill ──────────────────────────────────────────────────────────────
-- Recreate the old shape, then replay the migration.

alter table amux.app_member_access drop constraint app_member_access_permission_level_check;
update amux.app_member_access set permission_level = 'prompt'
 where member_id = '00000000-0000-0000-0046-000000000202';
\ir ../migrations/20261117000000_app_access_actor_grants.sql
select is((select permission_level from amux.app_member_access
            where member_id = '00000000-0000-0000-0046-000000000202'), 'write',
          'replaying the migration maps prompt to write');

select * from finish();
rollback;
