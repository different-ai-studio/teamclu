-- 20261127200000_app_platform_p3_forge: an app's repo lives in
-- app_forge_repos and its deployed revision in apps.deployed_revision; until
-- P3.4 both follow the old columns, and callers read the repo of the apps
-- they see (P3.3).
begin;

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

select plan(16);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org A: team A1 (creator), team A2 (outsider). Org B: team B1 (stranger).

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0067-0000000000fa', 'P3.3 org A'),
  ('00000000-0000-0000-0067-0000000000fb', 'P3.3 org B');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0067-000000000101', 'p33-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0067-000000000103', 'p33-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0067-000000000104', 'p33-stranger@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid) values
  ('00000000-0000-0000-0067-0000000000a1', 'p33-a1', 'P3.3 A1', '00000000-0000-0000-0067-0000000000fa'),
  ('00000000-0000-0000-0067-0000000000a2', 'p33-a2', 'P3.3 A2', '00000000-0000-0000-0067-0000000000fa'),
  ('00000000-0000-0000-0067-0000000000b1', 'p33-b1', 'P3.3 B1', '00000000-0000-0000-0067-0000000000fb');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0067-000000000201', '00000000-0000-0000-0067-0000000000a1', 'member', '00000000-0000-0000-0067-000000000101', 'Creator'),
  ('00000000-0000-0000-0067-000000000203', '00000000-0000-0000-0067-0000000000a2', 'member', '00000000-0000-0000-0067-000000000103', 'Outsider'),
  ('00000000-0000-0000-0067-000000000204', '00000000-0000-0000-0067-0000000000b1', 'member', '00000000-0000-0000-0067-000000000104', 'Stranger');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0067-000000000201', 'active'),
  ('00000000-0000-0000-0067-000000000203', 'active'),
  ('00000000-0000-0000-0067-000000000204', 'active');

-- app 1: personal, Gitea-hosted, deployed. app 2: team-visible, imported.
-- app 3: local, no remote.
insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id, visibility,
                       git_remote_url, git_auth_kind, git_commit_sha) values
  ('00000000-0000-0000-0067-000000000301', '00000000-0000-0000-0067-0000000000a1',
   '00000000-0000-0000-0067-000000000201', 'P3.3 gitea', 'p33-gitea', 'static_web',
   '00000000-0000-0000-0067-0000000000fa', 'personal',
   'ssh://git@gitea.test/o1/app-301.git', 'gitea_deploy_key', 'aaaaaaa'),
  ('00000000-0000-0000-0067-000000000302', '00000000-0000-0000-0067-0000000000a1',
   '00000000-0000-0000-0067-000000000201', 'P3.3 import', 'p33-import', 'static_web',
   '00000000-0000-0000-0067-0000000000fa', 'team',
   'https://example.test/r.git', null, null),
  ('00000000-0000-0000-0067-000000000303', '00000000-0000-0000-0067-0000000000a1',
   '00000000-0000-0000-0067-000000000201', 'P3.3 local', 'p33-local', 'static_web',
   '00000000-0000-0000-0067-0000000000fa', 'personal',
   null, null, null);

-- ── projection on insert ──────────────────────────────────────────────────
select is((select remote_url || ' ' || auth_kind from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000301'),
          'ssh://git@gitea.test/o1/app-301.git gitea_deploy_key',
          'a created app''s repo is projected');
select is((select auth_kind from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000302'), null,
          'an imported repo with no credential has no auth kind');
select is((select count(*)::int from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000303'), 0,
          'an app with no remote has no repo row');
select is((select deployed_revision from amux.apps where id = '00000000-0000-0000-0067-000000000301'), 'aaaaaaa',
          'the deployed revision follows git_commit_sha on insert');

-- ── projection on update (what an FC from before P3.3 writes) ─────────────
update amux.apps set git_auth_kind = 'https_token' where id = '00000000-0000-0000-0067-000000000302';
select is((select auth_kind from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000302'), 'https_token',
          'storing a credential follows');
update amux.apps set git_remote_url = 'ssh://git@gitea.test/o1/app-303.git', git_auth_kind = 'gitea_deploy_key'
 where id = '00000000-0000-0000-0067-000000000303';
select is((select remote_url from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000303'),
          'ssh://git@gitea.test/o1/app-303.git', 'a provisioned repo follows');
update amux.apps set git_remote_url = null, git_auth_kind = null where id = '00000000-0000-0000-0067-000000000303';
select is((select count(*)::int from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000303'), 0,
          'clearing the remote removes the repo row');
update amux.apps set git_commit_sha = 'bbbbbbb' where id = '00000000-0000-0000-0067-000000000301';
select is((select deployed_revision from amux.apps where id = '00000000-0000-0000-0067-000000000301'), 'bbbbbbb',
          'a finalize that writes only git_commit_sha moves the deployed revision');

-- ── dual write (what FC from P3.3 writes) ─────────────────────────────────
update amux.apps set git_commit_sha = 'ccccccc', deployed_revision = 'ccccccc'
 where id = '00000000-0000-0000-0067-000000000301';
select is((select deployed_revision from amux.apps where id = '00000000-0000-0000-0067-000000000301'), 'ccccccc',
          'writing both lands on the same value');
update amux.apps set git_commit_sha = 'ddddddd', deployed_revision = 'eeeeeee'
 where id = '00000000-0000-0000-0067-000000000301';
select is((select deployed_revision from amux.apps where id = '00000000-0000-0000-0067-000000000301'), 'eeeeeee',
          'an explicit deployed revision wins');
select lives_ok($$
  insert into amux.app_forge_repos (app_id, remote_url, auth_kind)
  values ('00000000-0000-0000-0067-000000000302', 'https://example.test/r.git', 'https_token')
  on conflict (app_id) do update set remote_url = excluded.remote_url, auth_kind = excluded.auth_kind
$$, 'the forge''s own upsert lands on the projected row');

-- ── reads ─────────────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0067-000000000101');
select is((select count(*)::int from amux.app_forge_repos where app_id in ('00000000-0000-0000-0067-000000000301', '00000000-0000-0000-0067-000000000302')), 2,
          'the creator reads the repos of their apps');
select throws_ok($$ update amux.app_forge_repos set remote_url = 'x' $$, '42501', null,
          'but cannot write them');
reset role;

select pg_temp.as_user('00000000-0000-0000-0067-000000000103');
select is((select count(*)::int from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000302'), 1,
          'an org member reads the repo of a team-visible app');
select is((select count(*)::int from amux.app_forge_repos where app_id = '00000000-0000-0000-0067-000000000301'), 0,
          'but not of a personal one');
reset role;

select pg_temp.as_user('00000000-0000-0000-0067-000000000104');
select is((select count(*)::int from amux.app_forge_repos where app_id::text like '00000000-0000-0000-0067-%'), 0,
          'nothing crosses into another org');
reset role;

select * from finish();
rollback;
