-- 20261126200000_app_platform_p2_rls: row security on apps and their tables
-- reads the platform model (caller_app_access + org grants).
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

select plan(20);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org A: teams A1, A2. Org B: team B1.
--   creator  — A1; app 1 (personal), app 2 (team-visible)
--   grantee  — A1; admin on app 1
--   outsider — A2 (same org, other team)
--   stranger — B1 (other org)
--   agent G  — grantee's agent in A1

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0064-0000000000fa', 'P2.3 org A'),
  ('00000000-0000-0000-0064-0000000000fb', 'P2.3 org B');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0064-000000000101', 'p23-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0064-000000000102', 'p23-grantee@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0064-000000000103', 'p23-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0064-000000000104', 'p23-stranger@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0064-000000000112', 'daemon.p23g@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid) values
  ('00000000-0000-0000-0064-0000000000a1', 'p23-a1', 'P2.3 A1', '00000000-0000-0000-0064-0000000000fa'),
  ('00000000-0000-0000-0064-0000000000a2', 'p23-a2', 'P2.3 A2', '00000000-0000-0000-0064-0000000000fa'),
  ('00000000-0000-0000-0064-0000000000b1', 'p23-b1', 'P2.3 B1', '00000000-0000-0000-0064-0000000000fb');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0064-000000000201', '00000000-0000-0000-0064-0000000000a1', 'member', '00000000-0000-0000-0064-000000000101', 'Creator'),
  ('00000000-0000-0000-0064-000000000202', '00000000-0000-0000-0064-0000000000a1', 'member', '00000000-0000-0000-0064-000000000102', 'Grantee'),
  ('00000000-0000-0000-0064-000000000203', '00000000-0000-0000-0064-0000000000a2', 'member', '00000000-0000-0000-0064-000000000103', 'Outsider'),
  ('00000000-0000-0000-0064-000000000204', '00000000-0000-0000-0064-0000000000b1', 'member', '00000000-0000-0000-0064-000000000104', 'Stranger'),
  ('00000000-0000-0000-0064-000000000212', '00000000-0000-0000-0064-0000000000a1', 'agent',  '00000000-0000-0000-0064-000000000112', 'Agent G');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0064-000000000201', 'active'),
  ('00000000-0000-0000-0064-000000000202', 'active'),
  ('00000000-0000-0000-0064-000000000203', 'active'),
  ('00000000-0000-0000-0064-000000000204', 'active');
insert into amux.agents (id, owner_member_id, status) values
  ('00000000-0000-0000-0064-000000000212', '00000000-0000-0000-0064-000000000202', 'active');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility) values
  ('00000000-0000-0000-0064-000000000301', '00000000-0000-0000-0064-0000000000a1',
   '00000000-0000-0000-0064-000000000201', 'P2.3 app', 'p23-app', 'static_web',
   '00000000-0000-0000-0064-0000000000fa', 'personal'),
  ('00000000-0000-0000-0064-000000000302', '00000000-0000-0000-0064-0000000000a1',
   '00000000-0000-0000-0064-000000000201', 'P2.3 team app', 'p23-team-app', 'static_web',
   '00000000-0000-0000-0064-0000000000fa', 'team');
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id) values
  ('00000000-0000-0000-0064-000000000301', '00000000-0000-0000-0064-000000000202', 'admin', '00000000-0000-0000-0064-000000000201');
insert into amux.app_env_vars (app_id, key, value) values
  ('00000000-0000-0000-0064-000000000301', 'P23_KEY', 'v'),
  ('00000000-0000-0000-0064-000000000302', 'P23_TEAM_KEY', 'v');

select ok(has_function_privilege('authenticated', 'amux.caller_sees_app(uuid)', 'execute'),
          'signed-in users can ask whether they see an app');
select ok(not has_function_privilege('anon', 'amux.caller_sees_app(uuid)', 'execute'),
          'anonymous callers cannot');

-- ── the creator ───────────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0064-000000000101');
select is((select count(*)::int from amux.apps where id in ('00000000-0000-0000-0064-000000000301', '00000000-0000-0000-0064-000000000302')),
          2, 'the creator sees both apps');
with u as (update amux.apps set name = 'Renamed' where id = '00000000-0000-0000-0064-000000000301' returning 1)
select is((select count(*)::int from u), 1, 'the creator updates the app row with their own token');
select lives_ok($$insert into amux.app_env_vars (app_id, key, value) values ('00000000-0000-0000-0064-000000000301', 'P23_NEW', 'v')$$,
                'the creator manages env vars');
select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0064-000000000301'),
          1, 'the creator reads the app''s grants');
reset role;

-- ── an admin grantee ──────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0064-000000000102');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000301'), 1,
          'a grantee sees the personal app');
with u as (update amux.apps set name = 'Nope' where id = '00000000-0000-0000-0064-000000000301' returning 1)
select is((select count(*)::int from u), 0, 'but its row stays the creator''s to update (the Cloud API escalates for admins)');
select is((select count(*)::int from amux.app_env_vars where app_id = '00000000-0000-0000-0064-000000000301'), 2,
          'a grantee reads the app''s env vars');
select throws_ok($$insert into amux.app_env_vars (app_id, key, value) values ('00000000-0000-0000-0064-000000000301', 'P23_X', 'v')$$,
                 '42501', null, 'a grantee does not manage them with their own token');
select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0064-000000000301'), 1,
          'a grantee reads their own grant row');
reset role;

-- ── the grantee's agent ───────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0064-000000000112');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000301'), 1,
          'a grantee''s agent sees the app through its owner');
select is((select count(*)::int from amux.app_member_access where app_id = '00000000-0000-0000-0064-000000000301'), 0,
          'and reads no grant rows (it holds none)');
reset role;

-- ── the same org, another team ────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0064-000000000103');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000302'), 1,
          'a team-visible app is visible to the whole org (Q4)');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000301'), 0,
          'a personal app is not');
select is((select count(*)::int from amux.app_env_vars where app_id = '00000000-0000-0000-0064-000000000302'), 0,
          'seeing a team-visible app shows none of its env vars');
reset role;

-- ── another org ───────────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0064-000000000104');
select is((select count(*)::int from amux.apps where id in ('00000000-0000-0000-0064-000000000301', '00000000-0000-0000-0064-000000000302')),
          0, 'nothing crosses into another org, team-visible or not');
reset role;

-- ── visibility follows the legacy column through P2.1's projection ────────

update amux.apps set visibility = 'personal' where id = '00000000-0000-0000-0064-000000000302';
select pg_temp.as_user('00000000-0000-0000-0064-000000000103');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000302'), 0,
          'making the app personal hides it from the org again');
reset role;

-- ── revoking the grant takes the agent's view with it ─────────────────────

delete from amux.app_member_access
 where app_id = '00000000-0000-0000-0064-000000000301' and member_id = '00000000-0000-0000-0064-000000000202';
select pg_temp.as_user('00000000-0000-0000-0064-000000000102');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000301'), 0,
          'a revoked grantee no longer sees the app');
reset role;
select pg_temp.as_user('00000000-0000-0000-0064-000000000112');
select is((select count(*)::int from amux.apps where id = '00000000-0000-0000-0064-000000000301'), 0,
          'nor does their agent');
reset role;

select * from finish();
rollback;
