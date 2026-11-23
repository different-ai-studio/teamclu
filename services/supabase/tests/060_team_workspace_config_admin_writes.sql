-- team_workspace_config: only a team owner or admin may write it
-- (20261119130000_team_workspace_config_admin_writes.sql).
--
-- The row holds the AI gateway every agent in the team sends prompts to, so a
-- plain member must not be able to repoint it. Every member can still read it.
begin;

select plan(7);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Same helper as 025_agent_delete_authz.sql: current_team_role reads org-scoped
-- bindings, so a role has to be granted on the team's org.
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

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0060-0000000000a1', 'twc-admin@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0060-0000000000a2', 'twc-member@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name) values
  ('00000000-0000-0000-0060-00000000000a', 'twc-admin-writes', 'TWC Admin Writes'),
  ('00000000-0000-0000-0060-00000000000b', 'twc-admin-writes-empty', 'TWC Empty');

insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
  ('00000000-0000-0000-0060-0000000001a1', '00000000-0000-0000-0060-00000000000a', 'member', 'Admin',  '00000000-0000-0000-0060-0000000000a1'),
  ('00000000-0000-0000-0060-0000000001a2', '00000000-0000-0000-0060-00000000000a', 'member', 'Member', '00000000-0000-0000-0060-0000000000a2'),
  ('00000000-0000-0000-0060-0000000001b2', '00000000-0000-0000-0060-00000000000b', 'member', 'Member', '00000000-0000-0000-0060-0000000000a2');

insert into amux.members (id, status) values
  ('00000000-0000-0000-0060-0000000001a1', 'active'),
  ('00000000-0000-0000-0060-0000000001a2', 'active'),
  ('00000000-0000-0000-0060-0000000001b2', 'active');

insert into amux.team_members (team_id, member_id, role) values
  ('00000000-0000-0000-0060-00000000000a', '00000000-0000-0000-0060-0000000001a1', 'member'),
  ('00000000-0000-0000-0060-00000000000a', '00000000-0000-0000-0060-0000000001a2', 'member'),
  ('00000000-0000-0000-0060-00000000000b', '00000000-0000-0000-0060-0000000001b2', 'member');

select pg_temp.grant_org_role('00000000-0000-0000-0060-00000000000a', '00000000-0000-0000-0060-0000000000a1', 'admin');

insert into amux.team_workspace_config (team_id, llm_base_url)
values ('00000000-0000-0000-0060-00000000000a', 'https://gw.team.example/v1');

-- ── Plain member ─────────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0060-0000000000a2');

select results_eq(
  $$ select llm_base_url from amux.team_workspace_config where team_id = '00000000-0000-0000-0060-00000000000a' $$,
  $$ values ('https://gw.team.example/v1'::text) $$,
  'member can read the team gateway config'
);

update amux.team_workspace_config set llm_base_url = 'https://attacker.example/v1'
 where team_id = '00000000-0000-0000-0060-00000000000a';
select results_eq(
  $$ select llm_base_url from amux.team_workspace_config where team_id = '00000000-0000-0000-0060-00000000000a' $$,
  $$ values ('https://gw.team.example/v1'::text) $$,
  'member UPDATE of the gateway is filtered out'
);

select throws_ok(
  $$ insert into amux.team_workspace_config (team_id, llm_base_url)
     values ('00000000-0000-0000-0060-00000000000b', 'https://attacker.example/v1') $$,
  '42501',
  null,
  'member cannot INSERT a config row for their team'
);

-- ── Admin ────────────────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0060-0000000000a1');

update amux.team_workspace_config set llm_base_url = 'https://gw2.team.example/v1'
 where team_id = '00000000-0000-0000-0060-00000000000a';
select results_eq(
  $$ select llm_base_url from amux.team_workspace_config where team_id = '00000000-0000-0000-0060-00000000000a' $$,
  $$ values ('https://gw2.team.example/v1'::text) $$,
  'admin can change the team gateway'
);

reset role;
select policies_are('amux', 'team_workspace_config', array[
  'team_workspace_config_select_if_team_member',
  'team_workspace_config_insert_if_team_admin',
  'team_workspace_config_update_if_team_admin',
  'team_workspace_config_delete_if_owner'
], 'team_workspace_config policy set');

select policy_cmd_is('amux', 'team_workspace_config', 'team_workspace_config_insert_if_team_admin', 'INSERT',
  'admin insert policy covers INSERT');
select policy_cmd_is('amux', 'team_workspace_config', 'team_workspace_config_update_if_team_admin', 'UPDATE',
  'admin update policy covers UPDATE');

select * from finish();
rollback;
