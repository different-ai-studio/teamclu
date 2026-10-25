-- Final-schema integration checks. The historical-to-current backfill and its
-- abort/rollback paths are exercised by FC's PGlite migration-chain tests.
begin;
select plan(13);

select ok(coalesce((select bool_and(app_code ~ '^a-[0-9a-hjkmnp-tv-z]{12}$') from amux.apps), true),
  'all stored app codes use the complete format');
select is(length(amux.generate_app_code()), 14, 'the generator returns the complete 14-character identity');

insert into public.orgs(id, name)
values ('00000000-0000-0000-0044-000000000005', 'Complete app code org');
insert into amux.teams(id, slug, name, oid)
values ('00000000-0000-0000-0044-000000000001', 'full-app-code-test', 'Full codes', '00000000-0000-0000-0044-000000000005');
insert into auth.users(id, email, aud, role, instance_id)
values ('00000000-0000-0000-0044-000000000004', 'full-code-owner@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into amux.actors(id, team_id, actor_type, user_id, display_name)
values ('00000000-0000-0000-0044-000000000002', '00000000-0000-0000-0044-000000000001', 'member', '00000000-0000-0000-0044-000000000004', 'Owner');
insert into amux.members(id, status) values ('00000000-0000-0000-0044-000000000002', 'active');
insert into amux.apps(id, team_id, created_by_actor_id, name, slug, type, org_id)
values ('00000000-0000-0000-0044-000000000003', '00000000-0000-0000-0044-000000000001', '00000000-0000-0000-0044-000000000002', '完整代码', 'full-code-test', 'static_web', '00000000-0000-0000-0044-000000000005');
insert into amux.apps(id, team_id, created_by_actor_id, name, slug, type, org_id, app_code,
  uses_app_code_domain, fc_endpoint, fc_function_name, fc_status, auth_mode)
values ('00000000-0000-0000-0044-000000000006', '00000000-0000-0000-0044-000000000001', '00000000-0000-0000-0044-000000000002', '旧名称域名', 'full-code-legacy', 'static_web', '00000000-0000-0000-0044-000000000005', 'a-g00000000000',
  false, 'https://existing.fcapp.run', 'existing-function', 'live', 'platform');
insert into amux.app_member_access(app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0044-000000000006', '00000000-0000-0000-0044-000000000002', 'admin', '00000000-0000-0000-0044-000000000002');

select ok((select app_code ~ '^a-[0-9a-hjkmnp-tv-z]{12}$' from amux.apps where slug = 'full-code-test'),
  'default inserts store the prefix exactly once');
select is((select app_code from amux.apps where slug = 'full-code-legacy'), 'a-g00000000000',
  'an already complete code retains its random tail');
create temporary table full_code_saved as
  select id, app_code, fc_endpoint, fc_function_name, fc_status, auth_mode, uses_app_code_domain
  from amux.apps where slug = 'full-code-legacy';
update amux.apps set name = '改名', slug = 'full-code-renamed' where id = '00000000-0000-0000-0044-000000000006';
select is((select app_code from amux.apps where slug = 'full-code-renamed'), 'a-g00000000000',
  'name and slug changes preserve the complete code');
select is((select a.id::text from amux.apps a join amux.app_member_access p on p.app_id = a.id
  where a.app_code = 'a-g00000000000' and p.permission_level = 'admin'),
  '00000000-0000-0000-0044-000000000006', 'member permissions still refer to the same UUID');
select results_eq($$select id, app_code, fc_endpoint, fc_function_name, fc_status, auth_mode, uses_app_code_domain
  from amux.apps where app_code = 'a-g00000000000'$$,
  $$select * from full_code_saved$$, 'deployment, auth and domain mode remain independent of renames');
select ok((select uses_app_code_domain from amux.apps where slug = 'full-code-test'), 'new apps still default to code domains');
select ok((select deploy_use_app_code_domain is null from amux.apps where slug = 'full-code-test'), 'default inserts have no pending deployment mode');
select throws_ok($$update amux.apps set app_code = 'a-111111111111' where slug = 'full-code-renamed'$$,
  '23514', 'app_code is immutable', 'ordinary writes cannot reassign the complete code');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, app_code)
  select team_id, created_by_actor_id, 'Raw', 'raw-full-code', type, org_id, 'g00000000000' from amux.apps where slug = 'full-code-test'$$,
  '%apps_app_code_format%', 'raw suffixes are no longer accepted');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, app_code)
  select team_id, created_by_actor_id, 'Duplicate', 'duplicate-full-code', type, org_id, app_code from amux.apps where slug = 'full-code-test'$$,
  '%apps_app_code_key%', 'the named uniqueness constraint is preserved');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, app_code)
  select team_id, created_by_actor_id, 'Null', 'null-full-code', type, org_id, null from amux.apps where slug = 'full-code-test'$$,
  '%null value in column "app_code"%', 'explicit null codes remain forbidden');

select * from finish();
rollback;
