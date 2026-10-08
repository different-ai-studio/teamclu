-- 20261008030000_tenant_creator_admin.sql: the creator of a new tenant is its
-- super admin, found again by phone or by email.
begin;

select plan(9);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

insert into auth.users (id, email, aud, role, instance_id) values
  ('47bb0000-0000-4000-8000-000000000001', 'Founder@Example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('47bb0000-0000-4000-8000-000000000002', '13800004702@teamclu.mobile', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

-- ── An email account names its team ────────────────────────────────────────
select pg_temp.as_user('47bb0000-0000-4000-8000-000000000001');
create temp table b1 as select * from amux.bootstrap_login_team(true, null, null, 'Acme Climbing');
reset role;

select is((select name from public.orgs where id = (select org_id from public.users where id = '47bb0000-0000-4000-8000-000000000001')),
          'Acme Climbing', 'the team name names the org');
select is((select team_name from b1), 'Acme Climbing', 'and the team');
select is((select role from b1), 'owner', 'the creator owns the team');
select is((select admin_type from public.users where id = '47bb0000-0000-4000-8000-000000000001'), 3::smallint, 'the creator is admin_type 3');
select is((select auth_user_id from public.users where id = '47bb0000-0000-4000-8000-000000000001'),
          '47bb0000-0000-4000-8000-000000000001'::uuid, 'auth_user_id points at the account');
select is((select email::text from public.email_users_links where user_id = '47bb0000-0000-4000-8000-000000000001'),
          'founder@example.test', 'the email account is linked');

-- ── A phone account ────────────────────────────────────────────────────────
select pg_temp.as_user('47bb0000-0000-4000-8000-000000000002');
create temp table b2 as select * from amux.bootstrap_login_team(true, null, null, 'Phone Crew');
reset role;
select is((select mobile::text from public.users where id = '47bb0000-0000-4000-8000-000000000002'), '13800004702',
          'a <phone>@teamclu.mobile account carries its phone');
select ok(not exists(select 1 from public.email_users_links where user_id = '47bb0000-0000-4000-8000-000000000002'),
          'and needs no email link');

-- ── An older client that sends no name ─────────────────────────────────────
insert into auth.users (id, email, aud, role, instance_id) values
  ('47bb0000-0000-4000-8000-000000000003', 'legacy@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
select pg_temp.as_user('47bb0000-0000-4000-8000-000000000003');
select lives_ok($$select * from amux.bootstrap_login_team(true, null, null, null)$$,
                'no team name still bootstraps (derived name)');
reset role;

select * from finish();
rollback;
