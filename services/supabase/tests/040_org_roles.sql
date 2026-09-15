-- 040_org_roles.sql
--
-- Org-scoped public.roles / public.roles_users: schema, system seed, backfill
-- from team_members.role, and current_team_role from roles_users only
-- (no team_members.role fallback).
--
-- Run via:
--   cd services/supabase/tests && ./run.sh 040_org_roles.sql

begin;

select plan(10);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_service()
returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
end;
$$;

-- ── Schema ──────────────────────────────────────────────────────────────────
select has_table('public', 'roles', 'roles exists');
select has_table('public', 'roles_users', 'roles_users exists');

select has_function('amux', 'has_org_role_code', array['uuid', 'text'],
  'has_org_role_code(team, code) exists');

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- One org, two teams under it. Owner on team A; same user is admin on team A
-- and member on team B → union; highest privilege for the org is admin when
-- only admin+member (separate user). Owner user gets owner via backfill.

create temporary table fx (
  org_id uuid,
  team_a uuid,
  team_b uuid,
  owner_user uuid,
  owner_actor_a uuid,
  multi_user uuid,
  multi_actor_a uuid,
  multi_actor_b uuid
) on commit drop;

grant select on fx to anon, authenticated, service_role;

select pg_temp.as_service();

do $$
declare
  v_org uuid := gen_random_uuid();
  v_team_a uuid := gen_random_uuid();
  v_team_b uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_multi uuid := gen_random_uuid();
  v_owner_actor uuid := gen_random_uuid();
  v_multi_a uuid := gen_random_uuid();
  v_multi_b uuid := gen_random_uuid();
begin
  insert into public.orgs (id, name) values (v_org, 'Org Roles Fixture');

  -- Trigger seeds four system roles; assert below.
  insert into amux.teams (id, slug, name, oid) values
    (v_team_a, 'org-roles-a-' || v_team_a::text, 'Team A', v_org),
    (v_team_b, 'org-roles-b-' || v_team_b::text, 'Team B', v_org);

  insert into auth.users (id, email, aud, role, instance_id) values
    (v_owner, 'org-roles-owner@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000'),
    (v_multi, 'org-roles-multi@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000')
  on conflict do nothing;

  -- roles_users.user_id → public.users(id); store auth uid as users.id.
  insert into public.users (id, auth_user_id, org_id, email) values
    (v_owner, v_owner, v_org, 'org-roles-owner@amux.test'),
    (v_multi, v_multi, v_org, 'org-roles-multi@amux.test');

  insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
    (v_owner_actor, v_team_a, 'member', 'Owner', v_owner),
    (v_multi_a, v_team_a, 'member', 'Multi A', v_multi),
    (v_multi_b, v_team_b, 'member', 'Multi B', v_multi);

  insert into amux.members (id, status) values
    (v_owner_actor, 'active'),
    (v_multi_a, 'active'),
    (v_multi_b, 'active');

  insert into amux.team_members (team_id, member_id, role) values
    (v_team_a, v_owner_actor, 'owner'),
    (v_team_a, v_multi_a, 'admin'),
    (v_team_b, v_multi_b, 'member');

  insert into fx (org_id, team_a, team_b, owner_user, owner_actor_a,
                  multi_user, multi_actor_a, multi_actor_b)
  values (v_org, v_team_a, v_team_b, v_owner, v_owner_actor,
          v_multi, v_multi_a, v_multi_b);
end $$;

-- Re-run backfill against fixture team_members (migration already ran once).
select amux.backfill_roles_users_from_team_members();

-- ── Seed: four system codes per org ─────────────────────────────────────────
select is(
  (select count(*)::int from public.roles r
    where r.org_id = (select org_id from fx)
      and r.is_system
      and r.code in ('owner', 'admin', 'member', 'finance')),
  4,
  'fixture org has four system role codes'
);

select ok(
  (select bool_and(code = any (array['owner','admin','member','finance']))
     from public.roles
    where org_id = (select org_id from fx) and is_system),
  'system role codes are exactly owner/admin/member/finance'
);

-- ── Backfill: owner team_members → roles_users owner ────────────────────────
select ok(
  exists (
    select 1
    from public.roles_users ru
    join public.roles r on r.id = ru.role_id
    where ru.user_id = (select owner_user from fx)
      and ru.org_id = (select org_id from fx)
      and r.code = 'owner'
      and ru.status = 'active'
      and ru.store_id is null
      and ru.is_primary = false
  ),
  'owner team_members.role backfills roles_users owner'
);

-- ── Backfill union: admin + member → both rows ──────────────────────────────
select is(
  (select count(*)::int from public.roles_users ru
    join public.roles r on r.id = ru.role_id
   where ru.user_id = (select multi_user from fx)
     and ru.org_id = (select org_id from fx)
     and r.code in ('admin', 'member')),
  2,
  'same user across teams unions admin + member roles_users'
);

-- ── current_team_role: owner ────────────────────────────────────────────────
select pg_temp.as_user((select owner_user from fx));

select is(
  amux.current_team_role((select team_a from fx)),
  'owner',
  'current_team_role returns owner for owner user'
);

-- ── current_team_role: admin beats member ───────────────────────────────────
select pg_temp.as_user((select multi_user from fx));

select is(
  amux.current_team_role((select team_a from fx)),
  'admin',
  'current_team_role returns admin when user has admin + member'
);

select is(
  amux.current_team_role((select team_b from fx)),
  'admin',
  'current_team_role is org-scoped: team B still sees admin from union'
);

select * from finish();
rollback;
