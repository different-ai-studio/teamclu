-- 20261108000000_platform_operator.sql + 20261108010000_support_identity.sql
-- + 20261108030000_support_session_request_gate.sql:
-- platform operators (admin_type 4 in the platform org) enter a customer org
-- through its shared support account, one auth session per entry.
begin;

select plan(46);

create or replace function pg_temp.as_user(p_user uuid, p_session uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated',
                      'session_id', coalesce(p_session::text, ''))::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_owner()
returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Orgs: P = platform, C = customer, X = elsewhere.
insert into public.orgs (id, name) values
  ('56aa0000-0000-4000-8000-00000000000a', 'Platform'),
  ('56aa0000-0000-4000-8000-00000000000c', 'Customer'),
  ('56aa0000-0000-4000-8000-00000000000e', 'Elsewhere');
insert into auth.users (id, email, aud, role, instance_id) values
  ('56bb0000-0000-4000-8000-000000000001', 'op1@support.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('56bb0000-0000-4000-8000-000000000002', 'op2@support.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('56bb0000-0000-4000-8000-000000000003', 'stray4@support.test','authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('56bb0000-0000-4000-8000-000000000004', 'founder@support.test','authenticated','authenticated', '00000000-0000-0000-0000-000000000000'),
  ('56bb0000-0000-4000-8000-000000000005', 'cust@support.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('56bb0000-0000-4000-8000-000000000001', '56bb0000-0000-4000-8000-000000000001', '56aa0000-0000-4000-8000-00000000000a', '13800005601', 4),
  ('56bb0000-0000-4000-8000-000000000002', '56bb0000-0000-4000-8000-000000000002', '56aa0000-0000-4000-8000-00000000000a', '13800005602', 4),
  ('56bb0000-0000-4000-8000-000000000003', '56bb0000-0000-4000-8000-000000000003', '56aa0000-0000-4000-8000-00000000000e', '13800005603', 4),
  ('56bb0000-0000-4000-8000-000000000004', '56bb0000-0000-4000-8000-000000000004', '56aa0000-0000-4000-8000-00000000000a', '13800005604', 3),
  ('56bb0000-0000-4000-8000-000000000005', '56bb0000-0000-4000-8000-000000000005', '56aa0000-0000-4000-8000-00000000000c', '', 3);
insert into amux.teams (id, name, slug, oid) values
  ('56cc0000-0000-4000-8000-00000000000c', 'customer', 'customer-56', '56aa0000-0000-4000-8000-00000000000c'),
  ('56cc0000-0000-4000-8000-0000000000c2', 'customer-2', 'customer-56-2', '56aa0000-0000-4000-8000-00000000000c'),
  ('56cc0000-0000-4000-8000-00000000000a', 'platform', 'platform-56', '56aa0000-0000-4000-8000-00000000000a');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('56dd0000-0000-4000-8000-000000000005', '56cc0000-0000-4000-8000-00000000000c', 'member', '56bb0000-0000-4000-8000-000000000005', 'Customer');
insert into amux.members (id, status) values ('56dd0000-0000-4000-8000-000000000005', 'active');

-- ── S1: who is a platform operator ─────────────────────────────────────────
select is(amux.platform_org_id(), null, 'no platform org until the deployment sets one');
select ok(not amux.is_platform_operator('56bb0000-0000-4000-8000-000000000001'),
          'nobody is an operator while platform_org_id is unset');

insert into amux.deployment_settings (key, value)
values ('platform_org_id', '"56aa0000-0000-4000-8000-00000000000a"')
on conflict (key) do update set value = excluded.value;

select is(amux.platform_org_id(), '56aa0000-0000-4000-8000-00000000000a'::uuid, 'platform_org_id reads the setting');
select ok(amux.is_platform_operator('56bb0000-0000-4000-8000-000000000001'), 'admin_type 4 in the platform org is an operator');
select ok(not amux.is_platform_operator('56bb0000-0000-4000-8000-000000000003'), 'admin_type 4 in another org is not');
select ok(not amux.is_platform_operator('56bb0000-0000-4000-8000-000000000004'), 'admin_type 3 in the platform org is not');
select ok(not amux.is_platform_operator(null), 'a null user is not');

update amux.deployment_settings set value = '"not-a-uuid"' where key = 'platform_org_id';
select is(amux.platform_org_id(), null, 'a malformed setting reads as unset');
update amux.deployment_settings set value = '"56aa0000-0000-4000-8000-00000000000a"' where key = 'platform_org_id';

select ok(not has_table_privilege('authenticated', 'amux.support_grants', 'select'), 'clients cannot read support_grants');
select ok(not has_table_privilege('authenticated', 'amux.support_identities', 'select'), 'clients cannot read support_identities');
select ok(not has_function_privilege('authenticated', 'amux.is_platform_operator(uuid)', 'execute'),
          'clients cannot probe who is an operator');
select ok(not has_function_privilege('authenticated', 'amux.start_support_session(uuid, uuid, text, interval)', 'execute'),
          'clients cannot start a support session');

-- ── S2: entering ───────────────────────────────────────────────────────────
select throws_ok($$ select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000003', '56cc0000-0000-4000-8000-00000000000c', 'help') $$,
                 '42501', null, 'a non-operator cannot enter');
select throws_ok($$ select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000001', '56cc0000-0000-4000-8000-00000000000c', '  ') $$,
                 '22023', null, 'a reason is required');
select throws_ok($$ select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000001', '56cc0000-0000-4000-8000-00000000000a', 'help') $$,
                 '22023', null, 'the platform org is not entered through support');

create temp table s1 as
  select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000001', '56cc0000-0000-4000-8000-00000000000c', 'ticket 1');
create temp table s2 as
  select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000002', '56cc0000-0000-4000-8000-00000000000c', 'ticket 2');

grant select on s1, s2 to authenticated;

select is((select org_id from s1), '56aa0000-0000-4000-8000-00000000000c'::uuid, 'the grant is for the team''s org');
select is((select support_user_id from s2), (select support_user_id from s1), 'two operators share the org''s one support account');
select isnt((select session_id from s2), (select session_id from s1), 'but each gets its own auth session');
select is((select actor_id from s2), (select actor_id from s1), 'and the same actor in the team');
select is((select count(*)::int from auth.sessions where user_id = (select support_user_id from s1)), 2,
          'one auth session per entry');
select is((select array[admin_type::int::text, org_id::text, nickname] from public.users where id = (select support_user_id from s1)),
          array['2', '56aa0000-0000-4000-8000-00000000000c', 'TeamClu 支持'],
          'the support identity is admin_type 2 in the customer org');

-- As the support account, in the customer team.
select pg_temp.as_user((select support_user_id from s1), (select session_id from s1));
select is(amux.current_team_role('56cc0000-0000-4000-8000-00000000000c'), 'owner', 'the support account is an org owner');
select ok(amux.is_team_member('56cc0000-0000-4000-8000-00000000000c'), 'and a member of the team it entered');
select is((select count(*)::int from amux.list_my_identities()), 1, 'its identity picker holds only itself');
select ok(amux.support_grant_active(), 'its live grant is active');
select lives_ok('select amux.check_support_request()', 'the request gate lets a live support session through');
select throws_ok($$ select * from amux.switch_active_team('56cc0000-0000-4000-8000-00000000000c') $$,
                 '42501', null, 'a support session cannot mint itself another session by switching team');
select throws_ok(format('select amux.mint_identity_session(%L)', (select support_user_id from s1)),
                 '42501', null, 'nor through the identity picker');
select pg_temp.as_user((select support_user_id from s1), gen_random_uuid());
select ok(not amux.support_grant_active(), 'a session with no grant is not');
select throws_ok('select amux.check_support_request()', '42501', 'support session ended',
                 'the request gate refuses a support session with no grant');
select pg_temp.as_user((select support_user_id from s1));
select throws_ok('select amux.check_support_request()', '42501', null,
                 'and a support token without a session_id');
select pg_temp.as_user('56bb0000-0000-4000-8000-000000000005');
select ok(amux.support_grant_active(), 'support_grant_active never blocks ordinary callers');
select lives_ok('select amux.check_support_request()', 'nor does the request gate');
select ok(not exists (select 1 from amux.list_my_identities() i where i.user_id = (select support_user_id from s1)),
          'the support account is in no customer''s identity picker');
select pg_temp.as_owner();
select lives_ok('select amux.check_support_request()', 'the request gate ignores a request with no JWT');
select set_config('request.jwt.claims', '{"sub":"not-a-uuid","role":"authenticated"}', true);
select lives_ok('select amux.check_support_request()', 'and one whose sub is not a uuid');
select pg_temp.as_owner();
select ok(has_function_privilege('anon', 'amux.check_support_request()', 'execute')
          and has_function_privilege('authenticated', 'amux.check_support_request()', 'execute'),
          'every role PostgREST switches to may run the request gate');
select ok(amux.is_support_account((select support_user_id from s1))
          and not amux.is_support_account('56bb0000-0000-4000-8000-000000000005'),
          'is_support_account tells the support account apart');

-- ── Leaving and expiry ─────────────────────────────────────────────────────
select ok(not amux.end_support_session('56bb0000-0000-4000-8000-000000000005', (select session_id from s1)),
          'a session is ended only by the account it belongs to');
select ok(amux.end_support_session((select support_user_id from s1), (select session_id from s1)), 'ending a support session');
select is((select array[(select count(*)::int from auth.sessions where id = (select session_id from s1)),
                        (select count(*)::int from auth.refresh_tokens where session_id = (select session_id from s1) and not revoked),
                        (select count(*)::int from auth.sessions where id = (select session_id from s2))]),
          array[0, 0, 1], 'removes that session and its refresh tokens, and leaves the other operator''s');
select pg_temp.as_user((select support_user_id from s1), (select session_id from s1));
select throws_ok('select amux.check_support_request()', '42501', null,
                 'the ended session''s still-unexpired access token is refused at once');
select pg_temp.as_user((select support_user_id from s2), (select session_id from s2));
select lives_ok('select amux.check_support_request()', 'while the other operator''s session keeps working');
select pg_temp.as_owner();

update amux.support_grants
   set created_at = now() - interval '5 hours', expires_at = now() - interval '1 hour'
 where session_id = (select session_id from s2);
select pg_temp.as_user((select support_user_id from s2), (select session_id from s2));
select throws_ok('select amux.check_support_request()', '42501', null,
                 'an expired grant is refused even before the sweep revokes it');
select pg_temp.as_owner();
select is(amux.expire_support_grants(), 1, 'an expired grant is swept');

-- A role taken from the support account by hand comes back on the next entry.
delete from public.roles_users where user_id = (select support_user_id from s1);
update amux.members set status = 'disabled' where id = (select actor_id from s1);
create temp table s3 as
  select * from amux.start_support_session('56bb0000-0000-4000-8000-000000000001', '56cc0000-0000-4000-8000-00000000000c', 'ticket 3');
select is((select array[(select count(*)::int from public.roles_users ru join public.roles r on r.id = ru.role_id
                          where ru.user_id = (select support_user_id from s3) and r.code = 'owner' and ru.status = 'active'),
                        (select count(*)::int from amux.members where id = (select actor_id from s3) and status = 'active')]),
          array[1, 1], 're-entering restores the owner role and reactivates the actor');

select * from finish();
rollback;
