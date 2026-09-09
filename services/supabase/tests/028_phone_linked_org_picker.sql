begin;

select plan(9);

create temporary table phone_picker_fixture (
  caller_id uuid not null,
  linked_id uuid not null,
  org_a uuid not null,
  org_b uuid not null,
  linked_private_team uuid not null
);

-- The fixture is read back while impersonating anon/authenticated, and a
-- temp table belongs to the session role: without this grant the first read
-- under `set role` fails with "permission denied for table phone_picker_fixture".
grant select on phone_picker_fixture to anon, authenticated;

do $$
declare
  v_caller uuid := gen_random_uuid();
  v_linked uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_org_a uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_org_other uuid := gen_random_uuid();
  -- Same phone as the caller, but NOT an employee identity: a customer record
  -- (admin_type 1, what the partner's member register is full of) and a
  -- soft-deleted employee record. Neither may pull its org into the picker.
  v_customer uuid := gen_random_uuid();
  v_ex_staff uuid := gen_random_uuid();
  v_org_customer uuid := gen_random_uuid();
  v_org_ex_staff uuid := gen_random_uuid();
  v_team_linked uuid := gen_random_uuid();
  v_team_customer uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values
    (v_caller, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_linked, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_other, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_customer, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_ex_staff, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name)
  values (v_org_a, 'Phone Org A'), (v_org_b, 'Phone Org B'), (v_org_other, 'Other Org'),
         (v_org_customer, 'Customer Org'), (v_org_ex_staff, 'Ex Staff Org');
  -- admin_type is spelled out: the caller keeps the customer-grade default a
  -- phone sign-up gets (their own row is retained unconditionally), while the
  -- linked identity has to be an EMPLOYEE for its org to join the picker.
  insert into public.users (id, auth_user_id, org_id, mobile, admin_type, deleted_at)
  values
    (v_caller, v_caller, v_org_a, '13800009991', 1, null),
    (v_linked, v_linked, v_org_b, '13800009991', 3, null),
    (v_other, v_other, v_org_other, '13800009992', 3, null),
    (v_customer, v_customer, v_org_customer, '13800009991', 1, null),
    (v_ex_staff, v_ex_staff, v_org_ex_staff, '13800009991', 3, now());
  insert into amux.teams (id, name, slug, oid, visibility)
  values
    (gen_random_uuid(), 'Caller private', 'phone-caller-private', v_org_a, 'private'),
    (v_team_linked, 'Linked private', 'phone-linked-private', v_org_b, 'private'),
    (gen_random_uuid(), 'A public', 'phone-a-public', v_org_a, 'public'),
    (gen_random_uuid(), 'B public', 'phone-b-public', v_org_b, 'public'),
    (gen_random_uuid(), 'Hidden private', 'phone-hidden-private', v_org_b, 'private'),
    (gen_random_uuid(), 'Other public', 'phone-other-public', v_org_other, 'public'),
    (gen_random_uuid(), 'Customer public', 'phone-customer-public', v_org_customer, 'public'),
    (v_team_customer, 'Customer private', 'phone-customer-private', v_org_customer, 'private'),
    (gen_random_uuid(), 'Ex staff public', 'phone-ex-staff-public', v_org_ex_staff, 'public');
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  select gen_random_uuid(), t.id, 'member', v_caller, 'Caller'
    from amux.teams t where t.slug = 'phone-caller-private';
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values (gen_random_uuid(), v_team_linked, 'member', v_linked, 'Linked');
  -- The customer-grade identity holds a membership of its own. This is what a
  -- phone sign-up looks like (DEFAULT_ORG, admin_type 1, a team it created), and
  -- it has to survive: membership is resolved phone-wide even though the ORG set
  -- is employees-only.
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values (gen_random_uuid(), v_team_customer, 'member', v_customer, 'Customer');
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_caller, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  -- Drop the impersonation before writing the fixture row: the temp table
  -- belongs to the session role, and a write as `authenticated` fails with
  -- "permission denied for table phone_picker_fixture".
  execute 'reset role';
  insert into phone_picker_fixture values (v_caller, v_linked, v_org_a, v_org_b, v_team_linked);
end $$;

select is(
  (select count(*)::int from amux.list_teams_for_picker(null, true)),
  5,
  'picker returns only member teams and public teams in employee orgs'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-linked-private' and is_member),
  'picker includes a private team joined by a same-phone identity'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-b-public' and not is_member),
  'picker includes public teams in every phone-linked org'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-hidden-private'),
  'picker excludes private teams with no phone-linked membership'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-other-public'),
  'picker excludes teams outside phone-linked orgs'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-customer-private' and is_member),
  'a team joined by a same-phone CUSTOMER identity stays visible'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-customer-public'),
  'a customer record sharing the phone does not pull its org into the picker'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-ex-staff-public'),
  'a soft-deleted employee record does not pull its org into the picker'
);
select ok(
  (select refresh_token is not null from amux.switch_active_team(linked_private_team) limit 1),
  'switching a linked private team mints the linked identity session'
) from phone_picker_fixture;

select * from finish();
rollback;
