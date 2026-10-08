-- 20261008040000_identity_selection.sql: a signed-in person lists their own
-- identities and can mint a session for any of them — and nobody else's.
begin;

select plan(7);

insert into public.orgs (id, name) values
  ('48aa0000-0000-4000-8000-000000000001', 'Own'),
  ('48aa0000-0000-4000-8000-000000000002', 'Company'),
  ('48aa0000-0000-4000-8000-000000000003', 'Gym');

insert into auth.users (id, email, aud, role, instance_id) values
  ('48bb0000-0000-4000-8000-000000000001', 'pick@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('48bb0000-0000-4000-8000-000000000002', '48bb0000-0000-4000-8000-000000000002@teamclu.email', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('48bb0000-0000-4000-8000-000000000003', 'card@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('48bb0000-0000-4000-8000-000000000009', 'stranger@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('48bb0000-0000-4000-8000-000000000001', '48bb0000-0000-4000-8000-000000000001', '48aa0000-0000-4000-8000-000000000001', '', 3),
  ('48bb0000-0000-4000-8000-000000000002', '48bb0000-0000-4000-8000-000000000002', '48aa0000-0000-4000-8000-000000000002', '', 2),
  ('48bb0000-0000-4000-8000-000000000003', '48bb0000-0000-4000-8000-000000000003', '48aa0000-0000-4000-8000-000000000003', '', 1),
  ('48bb0000-0000-4000-8000-000000000009', '48bb0000-0000-4000-8000-000000000009', '48aa0000-0000-4000-8000-000000000003', '', 2);
insert into public.email_users_links (email, user_id, org_id) values
  ('pick@example.test', '48bb0000-0000-4000-8000-000000000001', '48aa0000-0000-4000-8000-000000000001'),
  ('pick@example.test', '48bb0000-0000-4000-8000-000000000002', '48aa0000-0000-4000-8000-000000000002'),
  ('pick@example.test', '48bb0000-0000-4000-8000-000000000003', '48aa0000-0000-4000-8000-000000000003');
insert into amux.deployment_settings (key, value) values ('staff_only', 'true');

select set_config('request.jwt.claims',
  json_build_object('sub', '48bb0000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

create temp table mine as select * from amux.list_my_identities();
select is((select count(*)::int from mine), 2, 'two identities offered: own tenant and company');
select is((select org_name from mine where is_current), 'Own', 'the signed-in identity comes first, marked current');
select ok(not exists(select 1 from mine where user_id = '48bb0000-0000-4000-8000-000000000003'),
          'staff-only: the linked card is not offered');
select ok(amux.mint_identity_session('48bb0000-0000-4000-8000-000000000002') is not null,
          'a session can be minted for the company identity');
select throws_ok($$select amux.mint_identity_session('48bb0000-0000-4000-8000-000000000003')$$,
                 '42501', 'not one of your identities', 'but not for the card');
select throws_ok($$select amux.mint_identity_session('48bb0000-0000-4000-8000-000000000009')$$,
                 '42501', 'not one of your identities', 'nor for a stranger');
reset role;

select is(
  (select user_id from auth.refresh_tokens order by created_at desc, id desc limit 1),
  '48bb0000-0000-4000-8000-000000000002',
  'the minted refresh token belongs to the picked identity'
);

select * from finish();
rollback;
