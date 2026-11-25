-- 20261126100000_app_platform_p2_switch: amux.caller_app_access reads the
-- platform model (creator, user grants, delegations inside the app's org), and
-- slugs are unique per org.
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

create or replace function pg_temp.access(p_app uuid)
returns text language sql as $$
  select coalesce(
    (select level || case when delegated then ' delegated' else '' end
                  || case when is_creator then ' creator' else '' end
       from amux.caller_app_access(p_app)),
    'none')
$$;

select plan(15);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org A, teams A1 and A2; org B, team B1.
--   creator  — member of A1; creates app 1 (personal) and app 2 (team-visible)
--   grantee  — member of A1, granted write on app 1; also a member of B1,
--              granted admin on app 3 there
--   outsider — member of A2 (same org, other team), no grants
--   agent C  — creator's agent in A1; agent G — grantee's agent in A1;
--   agent W  — grantee's agent in A1 that also holds its own admin grant

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0063-0000000000fa', 'P2.2 org A'),
  ('00000000-0000-0000-0063-0000000000fb', 'P2.2 org B');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0063-000000000101', 'p22-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0063-000000000102', 'p22-grantee@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0063-000000000103', 'p22-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0063-000000000111', 'daemon.p22c@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0063-000000000112', 'daemon.p22g@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0063-000000000113', 'daemon.p22w@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid) values
  ('00000000-0000-0000-0063-0000000000a1', 'p22-a1', 'P2.2 A1', '00000000-0000-0000-0063-0000000000fa'),
  ('00000000-0000-0000-0063-0000000000a2', 'p22-a2', 'P2.2 A2', '00000000-0000-0000-0063-0000000000fa'),
  ('00000000-0000-0000-0063-0000000000b1', 'p22-b1', 'P2.2 B1', '00000000-0000-0000-0063-0000000000fb');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0063-000000000201', '00000000-0000-0000-0063-0000000000a1', 'member', '00000000-0000-0000-0063-000000000101', 'Creator'),
  ('00000000-0000-0000-0063-000000000202', '00000000-0000-0000-0063-0000000000a1', 'member', '00000000-0000-0000-0063-000000000102', 'Grantee'),
  ('00000000-0000-0000-0063-000000000203', '00000000-0000-0000-0063-0000000000a2', 'member', '00000000-0000-0000-0063-000000000103', 'Outsider'),
  ('00000000-0000-0000-0063-000000000204', '00000000-0000-0000-0063-0000000000b1', 'member', '00000000-0000-0000-0063-000000000102', 'Grantee in B'),
  ('00000000-0000-0000-0063-000000000211', '00000000-0000-0000-0063-0000000000a1', 'agent',  '00000000-0000-0000-0063-000000000111', 'Agent C'),
  ('00000000-0000-0000-0063-000000000212', '00000000-0000-0000-0063-0000000000a1', 'agent',  '00000000-0000-0000-0063-000000000112', 'Agent G'),
  ('00000000-0000-0000-0063-000000000213', '00000000-0000-0000-0063-0000000000a1', 'agent',  '00000000-0000-0000-0063-000000000113', 'Agent W');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0063-000000000201', 'active'),
  ('00000000-0000-0000-0063-000000000202', 'active'),
  ('00000000-0000-0000-0063-000000000203', 'active'),
  ('00000000-0000-0000-0063-000000000204', 'active');
insert into amux.agents (id, owner_member_id, status) values
  ('00000000-0000-0000-0063-000000000211', '00000000-0000-0000-0063-000000000201', 'active'),
  ('00000000-0000-0000-0063-000000000212', '00000000-0000-0000-0063-000000000202', 'active'),
  ('00000000-0000-0000-0063-000000000213', '00000000-0000-0000-0063-000000000202', 'active');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility) values
  ('00000000-0000-0000-0063-000000000301', '00000000-0000-0000-0063-0000000000a1',
   '00000000-0000-0000-0063-000000000201', 'P2.2 app', 'p22-app', 'static_web',
   '00000000-0000-0000-0063-0000000000fa', 'personal'),
  ('00000000-0000-0000-0063-000000000302', '00000000-0000-0000-0063-0000000000a1',
   '00000000-0000-0000-0063-000000000201', 'P2.2 team app', 'p22-team-app', 'static_web',
   '00000000-0000-0000-0063-0000000000fa', 'team'),
  ('00000000-0000-0000-0063-000000000303', '00000000-0000-0000-0063-0000000000b1',
   '00000000-0000-0000-0063-000000000204', 'P2.2 B app', 'p22-b-app', 'static_web',
   '00000000-0000-0000-0063-0000000000fb', 'personal');
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id) values
  ('00000000-0000-0000-0063-000000000301', '00000000-0000-0000-0063-000000000202', 'write', '00000000-0000-0000-0063-000000000201'),
  ('00000000-0000-0000-0063-000000000301', '00000000-0000-0000-0063-000000000213', 'admin', '00000000-0000-0000-0063-000000000201');

-- ── privileges ────────────────────────────────────────────────────────────

select ok(has_function_privilege('authenticated', 'amux.caller_app_access(uuid)', 'execute'),
          'signed-in users can ask for their own level');
select ok(not has_function_privilege('anon', 'amux.caller_app_access(uuid)', 'execute'),
          'anonymous callers cannot');

-- ── direct levels ─────────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0063-000000000101');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'admin creator', 'the creator is admin');
reset role;

select pg_temp.as_user('00000000-0000-0000-0063-000000000102');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'write', 'a grantee has the granted level');
select is(pg_temp.access('00000000-0000-0000-0063-000000000303'), 'admin creator',
          'the same person is the creator of an app in their other org');
reset role;

select pg_temp.as_user('00000000-0000-0000-0063-000000000103');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'none', 'an org member with no grant has nothing');
select is(pg_temp.access('00000000-0000-0000-0063-000000000302'), 'none',
          'a team-visible app gives no level (its org grant only decides who sees it)');
select is(pg_temp.access('00000000-0000-0000-0063-000000000303'), 'none', 'an app in another org has no row');
reset role;

-- ── delegations ───────────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-0000-0063-000000000111');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'admin delegated',
          'the creator''s agent reaches admin through its owner, marked delegated');
reset role;

select pg_temp.as_user('00000000-0000-0000-0063-000000000112');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'write delegated',
          'a grantee''s agent reaches the grantee''s level');
select is(pg_temp.access('00000000-0000-0000-0063-000000000303'), 'none',
          'but not the owner''s apps in an org the agent does not belong to');
reset role;

select pg_temp.as_user('00000000-0000-0000-0063-000000000113');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'admin',
          'an agent''s own grant that beats its owner''s is not delegated');
reset role;

update amux.agents set status = 'disabled' where id = '00000000-0000-0000-0063-000000000212';
select pg_temp.as_user('00000000-0000-0000-0063-000000000112');
select is(pg_temp.access('00000000-0000-0000-0063-000000000301'), 'none', 'a disabled agent reaches nothing');
reset role;

-- ── slugs are unique per org ──────────────────────────────────────────────

select throws_ok(
  $$insert into amux.apps (team_id, created_by_actor_id, name, slug, type, org_id)
    values ('00000000-0000-0000-0063-0000000000a2', '00000000-0000-0000-0063-000000000203',
            'Clash', 'p22-app', 'static_web', '00000000-0000-0000-0063-0000000000fa')$$,
  '23505', null, 'the same slug in another team of the same org is refused');
select lives_ok(
  $$insert into amux.apps (team_id, created_by_actor_id, name, slug, type, org_id)
    values ('00000000-0000-0000-0063-0000000000b1', '00000000-0000-0000-0063-000000000204',
            'Elsewhere', 'p22-app', 'static_web', '00000000-0000-0000-0063-0000000000fb')$$,
  'the same slug in another org is fine');

select * from finish();
rollback;
