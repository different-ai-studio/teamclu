-- team_default_agent.test.sql
--
-- pgTAP tests for migration 20260630000000_add_team_default_agent.sql:
--   (a) owner can set a team-visible active agent
--   (b) non-admin member gets 42501 on set
--   (c) personal-visibility agent rejected (23514)
--   (d) inactive agent rejected (23514)
--   (e) cross-team agent rejected (23514)
--   (f) get_effective_default_agent falls back to team when member default unset
--   (g) get_effective_default_agent prefers member default when set
--   (h) ON DELETE SET NULL: deleting the agent row nulls teams.default_agent_id
--
-- Run via:
--   supabase db reset
--   supabase test db
-- or:
--   pg_prove -d "$DATABASE_URL" services/supabase/tests/team_default_agent.test.sql

begin;

select plan(8);

-- ── helpers ──────────────────────────────────────────────────────────────────

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_service_role()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true);
  -- SET LOCAL ROLE actually changes the session role (auto-resets at txn end).
  -- set_config('role', ...) only writes a GUC and does NOT switch the role.
  execute 'SET LOCAL ROLE service_role';
end;
$$;

-- ── fixtures ──────────────────────────────────────────────────────────────────

-- Auth users: owner and plain member
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

insert into auth.users (id, email, aud, role, instance_id) values
  ('da010001-0000-4000-8000-000000000001', 'tda-owner@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('da010001-0000-4000-8000-000000000002', 'tda-member@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

-- Team
insert into amux.teams (id, slug, name)
values ('da020001-0000-4000-8000-000000000000', 'tda-team', 'TDA Team');

-- Human actors + members + team membership
insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
  ('da030001-0000-4000-8000-000000000001', 'da020001-0000-4000-8000-000000000000', 'member', 'TDA Owner',  'da010001-0000-4000-8000-000000000001'),
  ('da030001-0000-4000-8000-000000000002', 'da020001-0000-4000-8000-000000000000', 'member', 'TDA Member', 'da010001-0000-4000-8000-000000000002');

insert into amux.members (id, status) values
  ('da030001-0000-4000-8000-000000000001', 'active'),
  ('da030001-0000-4000-8000-000000000002', 'active');

insert into amux.team_members (team_id, member_id, role) values
  ('da020001-0000-4000-8000-000000000000', 'da030001-0000-4000-8000-000000000001', 'owner'),
  ('da020001-0000-4000-8000-000000000000', 'da030001-0000-4000-8000-000000000002', 'member');

select pg_temp.grant_org_role(
  'da020001-0000-4000-8000-000000000000', 'da010001-0000-4000-8000-000000000001', 'owner');
select pg_temp.grant_org_role(
  'da020001-0000-4000-8000-000000000000', 'da010001-0000-4000-8000-000000000002', 'member');

-- Agent actors:
--   agent1 = team-visible, active   (primary team default)
--   agent2 = team-visible, active   (used for member default in test g)
--   agent3 = personal, active       (should be rejected as team default)
--   agent4 = team-visible, disabled (should be rejected as team default)
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('da040001-0000-4000-8000-000000000001', 'da020001-0000-4000-8000-000000000000', 'agent', 'TDA Agent Team 1'),
  ('da040001-0000-4000-8000-000000000002', 'da020001-0000-4000-8000-000000000000', 'agent', 'TDA Agent Team 2'),
  ('da040001-0000-4000-8000-000000000003', 'da020001-0000-4000-8000-000000000000', 'agent', 'TDA Agent Personal'),
  ('da040001-0000-4000-8000-000000000004', 'da020001-0000-4000-8000-000000000000', 'agent', 'TDA Agent Disabled');

insert into amux.agents (id, owner_member_id, status, visibility) values
  ('da040001-0000-4000-8000-000000000001', 'da030001-0000-4000-8000-000000000001', 'active',   'team'),
  ('da040001-0000-4000-8000-000000000002', 'da030001-0000-4000-8000-000000000001', 'active',   'team'),
  ('da040001-0000-4000-8000-000000000003', 'da030001-0000-4000-8000-000000000001', 'active',   'personal'),
  ('da040001-0000-4000-8000-000000000004', 'da030001-0000-4000-8000-000000000001', 'disabled', 'team');

-- Cross-team fixture: a second team with its own team-visible active agent.
-- This agent must be rejected when passed to set_team_default_agent for the first team.
insert into amux.teams (id, slug, name)
values ('da020002-0000-4000-8000-000000000000', 'tda-other-team', 'TDA Other Team');

-- agents.owner_member_id is NOT NULL and has to sit in the same team, so the
-- other team needs a member of its own before it can own an agent.
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('da030002-0000-4000-8000-000000000001', 'da020002-0000-4000-8000-000000000000', 'member', 'TDA Other Owner'),
  ('da040001-0000-4000-8000-000000000005', 'da020002-0000-4000-8000-000000000000', 'agent',  'TDA Agent Other Team');

insert into amux.members (id, status)
values ('da030002-0000-4000-8000-000000000001', 'active');

insert into amux.team_members (team_id, member_id, role)
values ('da020002-0000-4000-8000-000000000000', 'da030002-0000-4000-8000-000000000001', 'owner');

insert into amux.agents (id, owner_member_id, status, visibility)
values ('da040001-0000-4000-8000-000000000005', 'da030002-0000-4000-8000-000000000001', 'active', 'team');

-- ── (a) owner can set a team-visible active agent ────────────────────────────

select pg_temp.as_user('da010001-0000-4000-8000-000000000001');

select lives_ok(
  $$ select amux.set_team_default_agent(
       'da020001-0000-4000-8000-000000000000'::uuid,
       'da040001-0000-4000-8000-000000000001'::uuid) $$,
  'owner can set team-visible active agent'
);

-- ── (b) non-admin member cannot set (42501) ──────────────────────────────────

select pg_temp.as_user('da010001-0000-4000-8000-000000000002');

select throws_ok(
  $$ select amux.set_team_default_agent(
       'da020001-0000-4000-8000-000000000000'::uuid,
       'da040001-0000-4000-8000-000000000001'::uuid) $$,
  '42501', null, 'non-admin cannot set team default'
);

-- ── (c) personal agent rejected (23514) ──────────────────────────────────────

select pg_temp.as_user('da010001-0000-4000-8000-000000000001');

select throws_ok(
  $$ select amux.set_team_default_agent(
       'da020001-0000-4000-8000-000000000000'::uuid,
       'da040001-0000-4000-8000-000000000003'::uuid) $$,
  '23514', null, 'personal agent rejected as team default'
);

-- ── (d) inactive (disabled) agent rejected (23514) ───────────────────────────

select pg_temp.as_user('da010001-0000-4000-8000-000000000001');

select throws_ok(
  $$ select amux.set_team_default_agent(
       'da020001-0000-4000-8000-000000000000'::uuid,
       'da040001-0000-4000-8000-000000000004'::uuid) $$,
  '23514', null, 'disabled agent rejected as team default'
);

-- ── (e) cross-team agent rejected (23514) ────────────────────────────────────
-- agent5 is team-visible + active but belongs to a DIFFERENT team → must be rejected

select throws_ok(
  $$ select amux.set_team_default_agent(
       'da020001-0000-4000-8000-000000000000'::uuid,
       'da040001-0000-4000-8000-000000000005'::uuid) $$,
  '23514', null, 'agent from a different team rejected as team default'
);

-- ── (f) effective falls back to team when member default is null ──────────────
-- team default is agent1 (set in test a); member (tda-member) has no default yet

select pg_temp.as_user('da010001-0000-4000-8000-000000000002');

select is(
  amux.get_effective_default_agent('da020001-0000-4000-8000-000000000000'::uuid),
  'da040001-0000-4000-8000-000000000001'::uuid,
  'effective falls back to team default when member default unset'
);

-- ── (g) effective prefers member default when set ────────────────────────────
-- as owner, set their own member default to agent2 (different from team default)

select pg_temp.as_user('da010001-0000-4000-8000-000000000001');

select amux.set_member_default_agent(
  'da020001-0000-4000-8000-000000000000'::uuid,
  'da040001-0000-4000-8000-000000000002'::uuid);

select is(
  amux.get_effective_default_agent('da020001-0000-4000-8000-000000000000'::uuid),
  'da040001-0000-4000-8000-000000000002'::uuid,
  'effective prefers member default over team default'
);

-- ── (h) ON DELETE SET NULL: deleting agent row nulls teams.default_agent_id ──
-- delete agent1 actor (cascades to agents row, then SET NULL on teams.default_agent_id)

select pg_temp.as_service_role();
delete from amux.actors where id = 'da040001-0000-4000-8000-000000000001';

select pg_temp.as_user('da010001-0000-4000-8000-000000000001');

select is(
  amux.get_team_default_agent('da020001-0000-4000-8000-000000000000'::uuid),
  null::uuid,
  'deleting the agent actor nulls teams.default_agent_id'
);

select * from finish();
rollback;
