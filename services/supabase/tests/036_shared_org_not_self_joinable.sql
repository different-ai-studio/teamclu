-- 20260909010000_shared_org_not_self_joinable.sql
--
-- The shared tenant (this deployment's DEFAULT_ORG_ID, passed in as
-- p_default_org_id) is the org phone sign-up stamps every account with. Being
-- "in" it therefore says nothing about belonging, and its public teams must not
-- be offered to — or joinable by — everyone who has ever signed up.
--
-- The exception that has to survive: an EMPLOYEE of that org still belongs to
-- it, and the picker's public row is their only self-serve way into the org's
-- team (bootstrap_login_team's shared-org branch deliberately gives them a
-- private team instead of joining them).
--
-- Both halves are asserted, on both functions, because the failure mode when
-- they disagree is a row the picker offers and the join refuses.

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

create temporary table shared_org_fixture (
  shared_org uuid not null,
  signup_id uuid not null,
  staff_id uuid not null,
  shared_public_team uuid not null,
  signup_private_team uuid not null
);
grant select on shared_org_fixture to anon, authenticated;

do $$
declare
  v_shared_org uuid := gen_random_uuid();
  v_signup uuid := gen_random_uuid();
  v_staff  uuid := gen_random_uuid();
  v_public_team uuid := gen_random_uuid();
  v_private_team uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values
    (v_signup, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_staff,  'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_shared_org, 'Shared Tenant');
  -- Both live in the shared org, which is exactly the point: same org, and only
  -- one of them an employee of it.
  insert into public.users (id, auth_user_id, org_id, mobile, admin_type)
  values
    (v_signup, v_signup, v_shared_org, '13800007771', 1),
    (v_staff,  v_staff,  v_shared_org, '13800007772', 3);
  insert into amux.teams (id, name, slug, oid, visibility)
  values
    (v_public_team,  'Shared Tenant', 'shared-tenant-public',  v_shared_org, 'public'),
    (v_private_team, 'Signup own',    'shared-signup-private', v_shared_org, 'private');
  -- What bootstrap_login_team's shared-org branch gives a phone sign-up.
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values (gen_random_uuid(), v_private_team, 'member', v_signup, 'Signup');
  insert into shared_org_fixture
  values (v_shared_org, v_signup, v_staff, v_public_team, v_private_team);
end $$;

-- ── The sign-up: in the org, not of it ──────────────────────────────────────
select pg_temp.as_user((select signup_id from shared_org_fixture));

select ok(
  not exists(
    select 1 from amux.list_teams_for_picker((select shared_org from shared_org_fixture), false)
     where team_slug = 'shared-tenant-public'),
  'a phone sign-up is not offered the shared tenant''s public team'
);

select ok(
  exists(
    select 1 from amux.list_teams_for_picker((select shared_org from shared_org_fixture), false)
     where team_slug = 'shared-signup-private' and is_member),
  'the sign-up still sees the private team bootstrap gave them'
);

select is(
  (select count(*)::int from amux.caller_employee_orgs()),
  0,
  'a customer-grade record is an employee of nothing'
);

-- Same call with no shared tenant configured: the own-org arm is back, which is
-- what a deployment without phone login gets. Proves the exclusion is the
-- parameter and not some other filter.
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, false) where team_slug = 'shared-tenant-public'),
  'with no shared tenant configured the own-org public team is offered as before'
);

select throws_ok(
  format($$ select amux.join_public_team(%L::uuid, %L::uuid) $$,
         (select shared_public_team from shared_org_fixture),
         (select shared_org from shared_org_fixture)),
  '42501', 'the shared tenant''s teams are not self-joinable',
  'a phone sign-up cannot self-join the shared tenant''s team'
);

-- ── The employee: in the org and of it ──────────────────────────────────────
select pg_temp.as_user((select staff_id from shared_org_fixture));

select is(
  (select count(*)::int from amux.caller_employee_orgs()),
  1,
  'an employee record resolves to its org'
);

select ok(
  exists(
    select 1 from amux.list_teams_for_picker((select shared_org from shared_org_fixture), false)
     where team_slug = 'shared-tenant-public' and not is_member),
  'an employee of the shared tenant is still offered its public team'
);

select ok(
  (select member_id from amux.join_public_team(
     (select shared_public_team from shared_org_fixture),
     (select shared_org from shared_org_fixture))) is not null,
  'an employee of the shared tenant can still self-join it'
);

select ok(
  exists(
    select 1 from amux.list_teams_for_picker((select shared_org from shared_org_fixture), false)
     where team_slug = 'shared-tenant-public' and is_member),
  'and the row flips to a membership afterwards'
);

select * from finish();
rollback;
