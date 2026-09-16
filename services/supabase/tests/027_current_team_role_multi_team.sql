-- 027_current_team_role_multi_team.sql
--
-- Multi-team user: oldest actor is on team A, newer actor on team B.
-- current_team_role(B) must not resolve through the team-A actor (the
-- current_member_id bug 20260813140000 fixed), and set_team_default_agent(B, …)
-- must succeed for an admin of B.
--
-- REWRITTEN for 20260915200000: roles are held in public.roles_users, which is
-- ORG-scoped. "owner of A and admin of B" is therefore only expressible when
-- A and B sit in DIFFERENT orgs — inside one org the two teams share one role
-- set, by design (see the design spec's "union of roles"). Each team here gets
-- its own org, which is what the product now produces: a team is created with
-- an org of its own, never dropped into a shared one.
--
-- Run via:
--   pg_prove -d "$DATABASE_URL" services/supabase/tests/027_current_team_role_multi_team.sql

begin;

select plan(4);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- amux.current_team_role reads public.roles_users, which is ORG-scoped, so a
-- fixture that seeds only amux.team_members.role leaves every actor at the
-- `member` floor. Give the team an org (creating one on the fly if it has
-- none — the orgs trigger seeds the four system roles) and the user a real
-- binding. See 20260915200000_org_roles.sql.
create or replace function pg_temp.grant_org_role(p_team uuid, p_user uuid, p_code text)
returns void language plpgsql as $$
declare
  v_org  uuid;
  v_role uuid;
begin
  select oid into v_org from amux.teams where id = p_team;
  if v_org is null then
    insert into public.orgs (name) values ('fixture ' || left(p_team::text, 8))
    returning id into v_org;
    update amux.teams set oid = v_org where id = p_team;
  end if;
  select id into v_role from public.roles
   where org_id = v_org and code = p_code and is_system limit 1;
  if v_role is null then
    raise exception 'fixture: no system role % for org %', p_code, v_org;
  end if;
  insert into public.roles_users (user_id, role_id, org_id, status, store_id, is_primary)
  values (p_user, v_role, v_org, 'active', null, false)
  on conflict do nothing;
end;
$$;

-- Auth user present on two teams
insert into auth.users (id, email, aud, role, instance_id) values
  ('c7a01001-0000-4000-8000-000000000001', 'ctr-multi@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into amux.teams (id, slug, name) values
  ('c7a02001-0000-4000-8000-00000000000a', 'ctr-team-a', 'CTR Team A'),
  ('c7a02001-0000-4000-8000-00000000000b', 'ctr-team-b', 'CTR Team B');

-- Team A actor created first (older) → would win under current_member_id()
insert into amux.actors (id, team_id, actor_type, display_name, user_id, created_at) values
  ('c7a03001-0000-4000-8000-00000000000a', 'c7a02001-0000-4000-8000-00000000000a', 'member', 'CTR On A', 'c7a01001-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z'),
  ('c7a03001-0000-4000-8000-00000000000b', 'c7a02001-0000-4000-8000-00000000000b', 'member', 'CTR On B', 'c7a01001-0000-4000-8000-000000000001', '2026-06-01T00:00:00Z');

insert into amux.members (id, status) values
  ('c7a03001-0000-4000-8000-00000000000a', 'active'),
  ('c7a03001-0000-4000-8000-00000000000b', 'active');

insert into amux.team_members (team_id, member_id, role) values
  ('c7a02001-0000-4000-8000-00000000000a', 'c7a03001-0000-4000-8000-00000000000a', 'owner'),
  ('c7a02001-0000-4000-8000-00000000000b', 'c7a03001-0000-4000-8000-00000000000b', 'admin');

-- Separate orgs: the helper mints one per team, so the same user can hold
-- different roles in each.
select pg_temp.grant_org_role(
  'c7a02001-0000-4000-8000-00000000000a', 'c7a01001-0000-4000-8000-000000000001', 'owner');
select pg_temp.grant_org_role(
  'c7a02001-0000-4000-8000-00000000000b', 'c7a01001-0000-4000-8000-000000000001', 'admin');

-- Team-visible active agent on B (valid team default)
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('c7a04001-0000-4000-8000-00000000000b', 'c7a02001-0000-4000-8000-00000000000b', 'agent', 'CTR Agent B');

insert into amux.agents (id, owner_member_id, status, visibility) values
  ('c7a04001-0000-4000-8000-00000000000b', 'c7a03001-0000-4000-8000-00000000000b', 'active', 'team');

select pg_temp.as_user('c7a01001-0000-4000-8000-000000000001');

select is(
  amux.current_member_id(),
  'c7a03001-0000-4000-8000-00000000000a'::uuid,
  'current_member_id still returns the oldest actor (team A)'
);

select is(
  amux.current_team_role('c7a02001-0000-4000-8000-00000000000b'::uuid),
  'admin',
  'current_team_role(B) resolves through team B''s own org → admin'
);

select is(
  amux.current_team_role('c7a02001-0000-4000-8000-00000000000a'::uuid),
  'owner',
  'current_team_role(A) still returns owner — the two orgs do not bleed'
);

select is(
  amux.set_team_default_agent(
    'c7a02001-0000-4000-8000-00000000000b'::uuid,
    'c7a04001-0000-4000-8000-00000000000b'::uuid
  ),
  'c7a04001-0000-4000-8000-00000000000b'::uuid,
  'admin on B can set_team_default_agent even when oldest actor is on A'
);

select * from finish();
rollback;
