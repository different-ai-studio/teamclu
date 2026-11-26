-- 20261127100000_app_platform_p3_read: callers read the app_links and
-- app_grants rows of the apps they see (TeamClu's fields of an app, P3.1).
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

select plan(12);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org A: teams A1, A2. Org B: team B1.
--   creator  — A1; app 1 (personal), app 2 (team-visible)
--   grantee  — A1; admin on app 1
--   outsider — A2 (same org, other team)
--   stranger — B1 (other org)
--   agent G  — grantee's agent in A1

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0065-0000000000fa', 'P3.1 org A'),
  ('00000000-0000-0000-0065-0000000000fb', 'P3.1 org B');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0065-000000000101', 'p31-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0065-000000000102', 'p31-grantee@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0065-000000000103', 'p31-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0065-000000000104', 'p31-stranger@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0065-000000000112', 'daemon.p31g@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid) values
  ('00000000-0000-0000-0065-0000000000a1', 'p31-a1', 'P3.1 A1', '00000000-0000-0000-0065-0000000000fa'),
  ('00000000-0000-0000-0065-0000000000a2', 'p31-a2', 'P3.1 A2', '00000000-0000-0000-0065-0000000000fa'),
  ('00000000-0000-0000-0065-0000000000b1', 'p31-b1', 'P3.1 B1', '00000000-0000-0000-0065-0000000000fb');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0065-000000000201', '00000000-0000-0000-0065-0000000000a1', 'member', '00000000-0000-0000-0065-000000000101', 'Creator'),
  ('00000000-0000-0000-0065-000000000202', '00000000-0000-0000-0065-0000000000a1', 'member', '00000000-0000-0000-0065-000000000102', 'Grantee'),
  ('00000000-0000-0000-0065-000000000203', '00000000-0000-0000-0065-0000000000a2', 'member', '00000000-0000-0000-0065-000000000103', 'Outsider'),
  ('00000000-0000-0000-0065-000000000204', '00000000-0000-0000-0065-0000000000b1', 'member', '00000000-0000-0000-0065-000000000104', 'Stranger'),
  ('00000000-0000-0000-0065-000000000212', '00000000-0000-0000-0065-0000000000a1', 'agent',  '00000000-0000-0000-0065-000000000112', 'Agent G');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0065-000000000201', 'active'),
  ('00000000-0000-0000-0065-000000000202', 'active'),
  ('00000000-0000-0000-0065-000000000203', 'active'),
  ('00000000-0000-0000-0065-000000000204', 'active');
insert into amux.agents (id, owner_member_id, status) values
  ('00000000-0000-0000-0065-000000000212', '00000000-0000-0000-0065-000000000202', 'active');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility) values
  ('00000000-0000-0000-0065-000000000301', '00000000-0000-0000-0065-0000000000a1',
   '00000000-0000-0000-0065-000000000201', 'P3.1 app', 'p31-app', 'static_web',
   '00000000-0000-0000-0065-0000000000fa', 'personal'),
  ('00000000-0000-0000-0065-000000000302', '00000000-0000-0000-0065-0000000000a1',
   '00000000-0000-0000-0065-000000000201', 'P3.1 team app', 'p31-team-app', 'static_web',
   '00000000-0000-0000-0065-0000000000fa', 'team');
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id) values
  ('00000000-0000-0000-0065-000000000301', '00000000-0000-0000-0065-000000000202', 'admin', '00000000-0000-0000-0065-000000000201');
insert into amux.app_env_vars (app_id, key, value) values
  ('00000000-0000-0000-0065-000000000301', 'P23_KEY', 'v'),
  ('00000000-0000-0000-0065-000000000302', 'P23_TEAM_KEY', 'v');


-- ── the creator ───────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0065-000000000101');
select is((select count(*)::int from amux.app_links where app_id in ('00000000-0000-0000-0065-000000000301', '00000000-0000-0000-0065-000000000302')), 2,
          'the creator reads the links of both apps');
select is((select team_id from amux.app_links where app_id = '00000000-0000-0000-0065-000000000301'), '00000000-0000-0000-0065-0000000000a1'::uuid,
          'a link names the app''s team');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0065-000000000301'), 1,
          'the creator reads every grant row of their app');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0065-000000000302' and principal_org_id is not null), 1,
          'and the org grant of their team-visible app');
reset role;

-- ── an admin grantee ──────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0065-000000000102');
select is((select count(*)::int from amux.app_links where app_id = '00000000-0000-0000-0065-000000000301'), 1,
          'a grantee reads the link of the app granted to them');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0065-000000000301' and principal_user_id = '00000000-0000-0000-0065-000000000102'), 1,
          'and their own grant row');
reset role;

-- ── the same org, another team ────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0065-000000000103');
select is((select count(*)::int from amux.app_links where app_id = '00000000-0000-0000-0065-000000000302'), 1,
          'an org member reads the link of a team-visible app');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0065-000000000302'), 1,
          'and its org grant');
select is((select count(*)::int from amux.app_links where app_id = '00000000-0000-0000-0065-000000000301'), 0,
          'but not the link of a personal app');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0065-000000000301'), 0,
          'nor other people''s grants on it');
reset role;

-- ── another org ───────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0065-000000000104');
select is((select count(*)::int from amux.app_links where app_id in ('00000000-0000-0000-0065-000000000301', '00000000-0000-0000-0065-000000000302')), 0,
          'nothing crosses into another org: no links');
select is((select count(*)::int from amux.app_grants where app_id in ('00000000-0000-0000-0065-000000000301', '00000000-0000-0000-0065-000000000302')), 0,
          'and no grants');
reset role;

select * from finish();
rollback;
