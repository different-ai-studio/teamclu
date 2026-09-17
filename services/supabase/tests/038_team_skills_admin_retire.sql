-- services/supabase/tests/038_team_skills_admin_retire.sql
-- Team skills: hard-delete and status/superseded_by changes are owner/admin only.
-- Members may still edit metadata (summary, etc.) via team_skills_update_if_member.
begin;

select plan(6);

create or replace function pg_temp.as_member(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create temporary table skill_fixture (
  team_id    uuid not null,
  admin_uid  uuid not null,
  member_uid uuid not null
) on commit drop;

grant select on skill_fixture to anon, authenticated, service_role;

create or replace function pg_temp.ensure_deploy_check()
returns void language plpgsql as $$
begin
  execute 'reset role';
  delete from amux.team_skills where slug = 'deploy-check';
  insert into amux.team_skills (
    team_id, slug, summary, category, when_to_use, when_not_to_use, status
  )
  select
    team_id, 'deploy-check', 'Deploy check skill', 'devops',
    'Before deploy', 'After deploy', 'published'
  from skill_fixture;
end;
$$;

-- Fixtures are written as the session role, like every other suite here.
-- service_role has no INSERT on auth.users, so switching to it first aborted
-- the whole transaction before a single assertion ran.
reset role;

do $$
declare
  v_org         uuid := gen_random_uuid();
  v_team        uuid := gen_random_uuid();
  v_owner_uid   uuid := gen_random_uuid();
  v_admin_uid   uuid := gen_random_uuid();
  v_member_uid  uuid := gen_random_uuid();
  v_owner_mem   uuid := gen_random_uuid();
  v_admin_mem   uuid := gen_random_uuid();
  v_member_mem  uuid := gen_random_uuid();
begin
  insert into public.orgs (id, name) values (v_org, 'Skill Retire Fixture');

  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,  'skill-owner@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_admin_uid,  'skill-admin@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid, 'skill-member@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  -- roles_users.user_id → public.users(id); store auth uid as users.id.
  insert into public.users (id, auth_user_id, org_id, email) values
    (v_owner_uid,  v_owner_uid,  v_org, 'skill-owner@amux.test'),
    (v_admin_uid,  v_admin_uid,  v_org, 'skill-admin@amux.test'),
    (v_member_uid, v_member_uid, v_org, 'skill-member@amux.test');

  insert into amux.teams (id, slug, name, oid)
  values (v_team, 'skill-retire-' || left(v_team::text, 8), 'Skill Retire', v_org);

  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,  v_team, 'member', 'Owner',  v_owner_uid),
    (v_admin_mem,  v_team, 'member', 'Admin',  v_admin_uid),
    (v_member_mem, v_team, 'member', 'Member', v_member_uid);

  insert into amux.members (id, status)
  values
    (v_owner_mem,  'active'),
    (v_admin_mem,  'active'),
    (v_member_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,  'owner'),
    (v_team, v_admin_mem,  'admin'),
    (v_team, v_member_mem, 'member');

  insert into skill_fixture (team_id, admin_uid, member_uid)
  values (v_team, v_admin_uid, v_member_uid);
end;
$$;

-- current_team_role reads roles_users only (no team_members.role fallback).
select amux.backfill_roles_users_from_team_members();

reset role;
insert into amux.team_skills (
  team_id, slug, summary, category, when_to_use, when_not_to_use, status
)
select
  team_id, 'deploy-check', 'Deploy check skill', 'devops',
  'Before deploy', 'After deploy', 'published'
from skill_fixture;

-- (1) Member DELETE is a no-op under RLS (row survives).
select pg_temp.as_member((select member_uid from skill_fixture));

select lives_ok(
  $$ delete from amux.team_skills where slug = 'deploy-check' $$,
  'member delete does not error'
);

select is(
  (select count(*)::int from amux.team_skills where slug = 'deploy-check'),
  1,
  'member delete leaves the row in place'
);

-- (2) Member cannot change status (trigger → 42501).
select pg_temp.ensure_deploy_check();
select pg_temp.as_member((select member_uid from skill_fixture));

select throws_ok(
  $$ update amux.team_skills set status = 'deprecated' where slug = 'deploy-check' $$,
  '42501', null,
  'member cannot deprecate a skill'
);

-- (3) Member can still edit metadata.
select lives_ok(
  $$ update amux.team_skills set summary = 'still allowed' where slug = 'deploy-check' $$,
  'member can update summary'
);

-- (4) Admin hard-delete succeeds.
select pg_temp.ensure_deploy_check();
select pg_temp.as_member((select admin_uid from skill_fixture));

select lives_ok(
  $$ delete from amux.team_skills where slug = 'deploy-check' $$,
  'admin delete succeeds'
);

select is(
  (select count(*)::int from amux.team_skills where slug = 'deploy-check'),
  0,
  'admin delete removes the row'
);

select * from finish();
rollback;
