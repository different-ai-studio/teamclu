begin;

select plan(19);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'anon')::text,
                     true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Fixture: owner (alice), same-team member (bob), stranger (cara)
-- create_team leaves the creator at the `member` floor: FC grants the owner
-- role in a separate service-role step (assignSystemOrgRole). Since
-- 20261119130000 only an owner/admin may write team_workspace_config, so the
-- fixture grants that role the same way 025_agent_delete_authz.sql does.
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
  ('a1111111-1111-1111-1111-111111111111', 'alice-wc@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('b2222222-2222-2222-2222-222222222222', 'bob-wc@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('c3333333-3333-3333-3333-333333333333', 'cara-wc@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select * from amux.create_team('WC Team', p_oid => null);
reset role;
select pg_temp.grant_org_role((select id from amux.teams where slug = 'wc-team'),
                              'a1111111-1111-1111-1111-111111111111', 'owner');
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');

create temp table ctx as
  select (select id from amux.teams where slug = 'wc-team') as team_id;

-- Seed Bob as the session role. actors has an INSERT policy scoped to the
-- caller's own identity, so building a second member while still impersonating
-- alice trips it -- the fixture is provisioning, not exercising, that policy.
reset role;

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values ('b2222222-0000-0000-0000-000000000000', (select team_id from ctx), 'member', 'Bob',
        'b2222222-2222-2222-2222-222222222222');

-- user_id moved to actors (identity is per team); members carries status only.
insert into amux.members (id, status)
values ('b2222222-0000-0000-0000-000000000000', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values (
  'b2222222-0000-0000-0000-000000000001',
  (select team_id from ctx),
  'b2222222-0000-0000-0000-000000000000',
  'member'
);

-- 1. Table exists
select has_table('amux', 'team_workspace_config', 'team_workspace_config table exists');

-- 2-9. Has expected columns
select has_column('amux', 'team_workspace_config', 'team_id', 'has team_id');
select has_column('amux', 'team_workspace_config', 'git_url', 'has git_url');
select has_column('amux', 'team_workspace_config', 'git_token', 'has git_token');
select has_column('amux', 'team_workspace_config', 'ai_gateway_endpoint', 'has ai_gateway_endpoint');
-- shared_dir_name / env_secret / last_sync_at / last_sync_error are gone. The
-- shared directory is fixed by the client, secrets moved to team_env_secrets,
-- and sync progress is tracked by oss_change_seq rather than a timestamp plus
-- an error string. The columns asserted here are the ones the row still has.
select has_column('amux', 'team_workspace_config', 'sync_mode', 'has sync_mode');
select has_column('amux', 'team_workspace_config', 'oss_change_seq', 'has oss_change_seq');
select has_column('amux', 'team_workspace_config', 'litellm_team_id', 'has litellm_team_id');
select has_column('amux', 'team_workspace_config', 'enabled', 'has enabled');

-- 10. Owner can write own team_workspace_config (the create_team RPC seeds an
-- empty row at team creation; the owner fills it in via UPDATE).
update amux.team_workspace_config
   set git_url             = 'https://github.com/x/y.git',
       git_branch          = 'main',
       git_token           = 'ghp_abc',
       ai_gateway_endpoint = 'https://gw.example'
 where team_id = (select team_id from ctx);
select pass('owner can update own team_workspace_config');

-- 11. Member can read
select results_eq(
  $$ select git_url from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'owner reads own row'
);

-- 12. Anon cannot read
select pg_temp.as_anon();
select throws_ok(
  $$ select 1 from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  '42501',
  null,
  'anon cannot read'
);

-- 13. Non-owner team member can read
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select git_url from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'non-owner team member reads own team row'
);

-- 14. The owner can fill in git/gateway columns (asserted above) but not
-- sync_mode: a guard trigger reserves it for service_role via
-- amux.set_team_sync_mode, so share mode cannot be flipped from a client
-- session. The path-traversal guard this slot used to hold went away with
-- shared_dir_name.
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ update amux.team_workspace_config set sync_mode = 'ftp' where team_id = (select team_id from ctx) $$,
  '42501',
  null,
  'owner cannot set sync_mode directly'
);

-- 15. Stranger cannot read
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select is_empty(
  $$ select 1 from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot read'
);

-- 16. Stranger UPDATE is silently filtered (RLS USING returns no row), so
-- the owner's row is unchanged.
update amux.team_workspace_config set git_url = 'https://stolen.example'
  where team_id = (select team_id from ctx);
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select results_eq(
  $$ select git_url from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'stranger UPDATE silently filtered (RLS)'
);
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');

-- 17. enabled defaults true (after switching back to alice)
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select results_eq(
  $$ select enabled from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values (true) $$,
  'enabled defaults true'
);

-- 18. Stranger cannot delete (no rows affected, row still exists)
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
delete from amux.team_workspace_config where team_id = (select team_id from ctx);
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select isnt_empty(
  $$ select 1 from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot delete'
);

-- 19. Owner can delete their own row
delete from amux.team_workspace_config where team_id = (select team_id from ctx);
select is_empty(
  $$ select 1 from amux.team_workspace_config where team_id = (select team_id from ctx) $$,
  'owner can delete own row'
);

select * from finish();
rollback;
