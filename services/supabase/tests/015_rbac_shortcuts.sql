-- services/supabase/tests/015_rbac_shortcuts.sql
begin;

select plan(20);

-- ── Fixture setup ────────────────────────────────────────────────────────
-- One team. owner is the team owner; m1 and m2 are plain members.
-- The per-role visibility layer (team_roles / team_member_roles /
-- permission_roles) was dropped in 20261119130000: a team shortcut is visible
-- to every team member.

create temp table fx(
  team_id uuid,
  owner_member uuid, owner_user uuid,
  m1_member uuid, m1_user uuid,
  m2_member uuid, m2_user uuid
) on commit drop;

-- Temp tables are owned by the session role; the tests then `set role` to
-- anon/authenticated/service_role, none of which can read them without an
-- explicit grant. service_role belongs on this list too -- half the assertions
-- below read fx while impersonating it to check rows past RLS.
grant select on fx to anon, authenticated, service_role;

-- amux.current_team_role reads amux.org_roles_users, which is ORG-scoped, so a
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
  insert into amux.org_roles_users (user_id, role_id, org_id, status, store_id, is_primary)
  values (p_user, v_role, v_org, 'active', null, false)
  on conflict do nothing;
end;
$$;

create or replace function pg_temp.mk_member(p_team uuid, p_name text, p_role text)
returns table(member_id uuid, user_id uuid)
language plpgsql as $$
declare v_actor uuid := gen_random_uuid(); v_user uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (v_user, p_name || '@test.local');
-- user_id lives on actors now: identity is per team, so the link to
-- auth.users belongs on the per-team row rather than on members.
  insert into amux.actors(id, team_id, actor_type, display_name, user_id)
    values (v_actor, p_team, 'member', p_name, v_user);
  insert into amux.members(id, status)
    values (v_actor, 'active');
  insert into amux.team_members(team_id, member_id, role)
    values (p_team, v_actor, p_role);
  perform pg_temp.grant_org_role(p_team, v_user, p_role);
  return query select v_actor, v_user;
end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
end $$;

-- Seed
insert into fx(team_id) values (gen_random_uuid());
insert into amux.teams(id, slug, name)
  select team_id, 'team-' || team_id::text, 'T' from fx;

update fx set (owner_member, owner_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'owner', 'owner'));
update fx set (m1_member, m1_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm1', 'member'));
update fx set (m2_member, m2_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm2', 'member'));

-- ── 1) Schema-level ─────────────────────────────────────────────────────
select hasnt_table('amux','team_roles',        'team_roles dropped');
select hasnt_table('amux','team_member_roles', 'team_member_roles dropped');
select has_table('amux','permissions',         'permissions exists');
select hasnt_table('amux','permission_roles',  'permission_roles dropped');
select has_table('amux','shortcuts',           'shortcuts exists');

-- 2) XOR constraint: personal with no owner_member_id is rejected
select pg_temp.as_service();
select throws_ok(
  $$ insert into amux.shortcuts(scope, label, node_type) values ('personal','x','link') $$,
  '23514',
  null,
  'XOR rejects personal shortcut with no owner_member_id'
);

-- 3) XOR constraint: team with both owner_member_id and team_id is rejected
select throws_ok(
  $$ insert into amux.shortcuts(scope, owner_member_id, team_id, label, node_type)
     values ('team', gen_random_uuid(), gen_random_uuid(), 'x', 'link') $$,
  '23514',
  null,
  'XOR rejects team shortcut with owner_member_id set'
);

-- ── Helpers ─────────────────────────────────────────────────────────────
--
-- Back to a member first. The XOR checks above left the session on
-- service_role, which holds no EXECUTE on these helpers -- and on this
-- Supabase image a call the current role cannot execute segfaults the backend
-- instead of raising 42501, taking the rest of the suite down with it. Never
-- call a function from a role that lacks EXECUTE on it; assert the privilege
-- with has_function_privilege instead (see QUARANTINE.md).
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select amux.is_team_admin_or_owner(gen_random_uuid()) $$,
  'helper: is_team_admin_or_owner'
);
select hasnt_function('amux', 'member_can_access_permission', array['uuid'],
                      'helper member_can_access_permission dropped');
select hasnt_function('amux', 'shortcut_set_visible_roles', array['uuid', 'uuid[]'],
                      'rpc shortcut_set_visible_roles dropped');
select lives_ok(
  $$ select amux.member_can_see_shortcut(gen_random_uuid()) $$,
  'helper: member_can_see_shortcut'
);

-- ── RPC: shortcut_create personal ───────────────────────────────────────
select pg_temp.as_user((select m1_user from fx));

select lives_ok(
  $$ select amux.shortcut_create('personal', 'My Link', 'link', null, null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create personal succeeds for any member'
);

-- ── RPC: shortcut_create team forbidden for non-admin ───────────────────
select throws_ok(
  $$ select amux.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  null,
  'forbidden',
  'rpc: shortcut_create team rejects non-admin'
);

-- ── RPC: shortcut_create team succeeds for owner; also creates permission row
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select amux.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create team succeeds for owner'
);

select pg_temp.as_service();
select is(
  (select count(*)::int from amux.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  1,
  'permissions row inserted for team shortcut'
);

-- ── RLS: personal isolation ─────────────────────────────────────────────
select pg_temp.as_user((select m2_user from fx));

select is(
  (select count(*)::int from amux.shortcuts
    where scope = 'personal'),
  0,
  'm2 cannot see m1''s personal shortcut'
);

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from amux.shortcuts where scope = 'personal'),
  1,
  'm1 sees own personal shortcut'
);

-- ── RLS: every team member sees a team shortcut ────────────────────────
select pg_temp.as_user((select m2_user from fx));
select is(
  (select count(*)::int from amux.shortcuts where scope = 'team'),
  1,
  'm2 sees the team shortcut'
);

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from amux.shortcuts where scope = 'team'),
  1,
  'm1 sees the team shortcut'
);

-- ── Trigger: deleting a team shortcut cleans up its permissions row ─────
select pg_temp.as_user((select owner_user from fx));
delete from amux.shortcuts
  where scope = 'team' and team_id = (select team_id from fx);

select pg_temp.as_service();
select is(
  (select count(*)::int from amux.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  0,
  'cleanup trigger removes permissions row after team shortcut delete'
);

select * from finish();
rollback;
