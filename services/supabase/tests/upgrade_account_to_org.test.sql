begin;

select plan(11);

insert into public.orgs (id, name)
values ('00000000-0000-0000-0066-000000000001', 'Account upgrade shared org');

insert into auth.users (id, email, aud, role, instance_id, raw_app_meta_data)
values
  ('00000000-0000-0000-0066-000000000011', 'upgrade-owner@teamclu.test', 'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000', '{"provider":"email"}'),
  ('00000000-0000-0000-0066-000000000012', 'upgrade-other@teamclu.test', 'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000', '{}');

insert into public.users (id, org_id, mobile, email)
values ('00000000-0000-0000-0066-000000000011', '00000000-0000-0000-0066-000000000001', '', 'upgrade-owner@teamclu.test');

insert into amux.teams (id, slug, name, oid)
values
  ('00000000-0000-0000-0066-000000000021', 'account-upgrade-main', 'Account upgrade original team', '00000000-0000-0000-0066-000000000001'),
  ('00000000-0000-0000-0066-000000000022', 'account-upgrade-other', 'Account upgrade other team', '00000000-0000-0000-0066-000000000001');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('00000000-0000-0000-0066-000000000031', '00000000-0000-0000-0066-000000000021', 'member', '00000000-0000-0000-0066-000000000011', 'Owner'),
  ('00000000-0000-0000-0066-000000000032', '00000000-0000-0000-0066-000000000022', 'member', '00000000-0000-0000-0066-000000000012', 'Other owner');

insert into amux.members (id, status)
values ('00000000-0000-0000-0066-000000000031', 'active'), ('00000000-0000-0000-0066-000000000032', 'active');

insert into amux.team_members (team_id, member_id, role)
values
  ('00000000-0000-0000-0066-000000000021', '00000000-0000-0000-0066-000000000031', 'owner'),
  ('00000000-0000-0000-0066-000000000022', '00000000-0000-0000-0066-000000000032', 'owner');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id)
values
  ('00000000-0000-0000-0066-000000000041', '00000000-0000-0000-0066-000000000021',
   '00000000-0000-0000-0066-000000000031', 'Upgrade static app', 'upgrade-static', 'static_web',
   '00000000-0000-0000-0066-000000000001'),
  ('00000000-0000-0000-0066-000000000042', '00000000-0000-0000-0066-000000000021',
   '00000000-0000-0000-0066-000000000031', 'Upgrade data app', 'upgrade-data', 'data_app',
   '00000000-0000-0000-0066-000000000001'),
  ('00000000-0000-0000-0066-000000000043', '00000000-0000-0000-0066-000000000022',
   '00000000-0000-0000-0066-000000000032', 'Unrelated static app', 'upgrade-other', 'static_web',
   '00000000-0000-0000-0066-000000000001');

create temporary table upgrade_result (org_id uuid, team_id uuid, team_name text);
grant insert on upgrade_result to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0066-000000000012","role":"authenticated"}';
select throws_ok(
  $$ select * from amux.upgrade_account_to_org('00000000-0000-0000-0066-000000000021', 'Forbidden org') $$,
  '42501', 'only the team owner can upgrade',
  'another team owner cannot upgrade this team');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0066-000000000011","role":"authenticated"}';
select throws_ok(
  $$ select * from amux.upgrade_account_to_org('00000000-0000-0000-0066-000000000021', 'Blocked org') $$,
  '23514',
  $$cannot move team 00000000-0000-0000-0066-000000000021 to another org: app(s) upgrade-data keep their data in the current org's database, and moving the team would point them at an empty schema in the new one$$,
  'a data app bound to the old organization blocks the move');
reset role;

select is((
  select count(*) from public.orgs where name in ('Forbidden org', 'Blocked org')
), 0::bigint, 'rejected upgrades do not create an organization');
select ok(
  (select oid = '00000000-0000-0000-0066-000000000001' from amux.teams where id = '00000000-0000-0000-0066-000000000021')
  and (select org_id = '00000000-0000-0000-0066-000000000001' from public.users where id = '00000000-0000-0000-0066-000000000011')
  and (select raw_app_meta_data = '{"provider":"email"}'::jsonb from auth.users where id = '00000000-0000-0000-0066-000000000011'),
  'the rejected upgrade preserves the team, profile and Auth metadata');

delete from amux.apps where id = '00000000-0000-0000-0066-000000000042';

set local role authenticated;
select lives_ok(
  $$ insert into pg_temp.upgrade_result
     select * from amux.upgrade_account_to_org(
       '00000000-0000-0000-0066-000000000021',
       'Upgraded team org',
       'Fixture contact',
       '00000000-0000-0000-0066-000000000001'
     ) $$,
  'the owner can upgrade an account when its apps have no database');
reset role;

select is((select team_id from upgrade_result), '00000000-0000-0000-0066-000000000021'::uuid,
  'the upgrade returns the original team ID');
select ok(exists (
  select 1 from public.orgs o join upgrade_result r on r.org_id = o.id
  join amux.teams t on t.id = r.team_id and t.oid = o.id
  where o.name = 'Upgraded team org' and o.contact = 'Fixture contact'
    and t.name = 'Upgraded team org' and r.team_name = t.name
    and o.id <> '00000000-0000-0000-0066-000000000001'
), 'the upgrade creates a new organization and renames and moves the team');
select is((select org_id from public.users where id = '00000000-0000-0000-0066-000000000011'),
  (select org_id from upgrade_result), 'the user profile moves to the new organization');
select is((select raw_app_meta_data from auth.users where id = '00000000-0000-0000-0066-000000000011'),
  (select jsonb_build_object('org_id', org_id::text, 'provider', 'email') from upgrade_result),
  'the Auth org claim is stamped and existing metadata is preserved');
select is((select org_id from amux.apps where id = '00000000-0000-0000-0066-000000000041'),
  (select org_id from upgrade_result), 'the upgraded team static app follows its team');
select is((select org_id from amux.apps where id = '00000000-0000-0000-0066-000000000043'),
  '00000000-0000-0000-0066-000000000001'::uuid, 'the other team static app stays in the shared organization');

select * from finish();
rollback;
