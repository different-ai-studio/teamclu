-- Exercise the real expand migration on historical rows as well as its final
-- insert/update contract. Every fixture and DDL change rolls back with this test.
begin;
select plan(19);
select has_column('amux', 'apps', 'function_naming_mode', 'apps records its function naming mode');

insert into public.orgs(id, name) values ('00000000-0000-0000-0045-000000000005', 'Function mode org');
insert into amux.teams(id, slug, name, oid) values
 ('00000000-0000-0000-0045-000000000001', 'function-mode-test', 'Function modes', '00000000-0000-0000-0045-000000000005');
insert into auth.users(id, email, aud, role, instance_id) values
 ('00000000-0000-0000-0045-000000000004', 'mode-owner@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into amux.actors(id, team_id, actor_type, user_id, display_name) values
 ('00000000-0000-0000-0045-000000000002', '00000000-0000-0000-0045-000000000001', 'member', '00000000-0000-0000-0045-000000000004', 'Owner');
insert into amux.members(id, status) values ('00000000-0000-0000-0045-000000000002', 'active');

insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, fc_status, fc_function_name, fc_endpoint, uses_app_code_domain)
select '00000000-0000-0000-0045-000000000001', '00000000-0000-0000-0045-000000000002',
 label, 'function-mode-' || label, 'static_web', '00000000-0000-0000-0045-000000000005', status,
 case when label = 'live' then 'old-function' end,
 case when label = 'live' then 'https://old-function.fcapp.run' end, code_domain
from (values ('live', 'live', false), ('never', null, false),
 ('failed', 'deploy_error', false), ('uninstalled', 'uninstalled', false),
 ('code-domain', 'live', true)) as historical(label, status, code_domain);
insert into amux.app_member_access(app_id, member_id, permission_level, granted_by_member_id)
select id, created_by_actor_id, 'admin', created_by_actor_id from amux.apps
where team_id = '00000000-0000-0000-0045-000000000001';

-- Recreate the historical shape inside this isolated transaction, snapshot it,
-- then replay the real migration rather than duplicating its implementation.
drop trigger apps_function_naming_mode_immutable on amux.apps;
alter table amux.apps drop column function_naming_mode;
create temporary table historical_apps as
 select to_jsonb(a) as row from amux.apps a
 where team_id = '00000000-0000-0000-0045-000000000001';
create temporary table historical_access as
 select to_jsonb(p) as row from amux.app_member_access p
 where app_id in (select (row->>'id')::uuid from historical_apps);
\ir ../migrations/20261026060936_apps_function_naming_mode.sql
select results_eq($$select to_jsonb(a) - 'function_naming_mode' from amux.apps a
 where team_id = '00000000-0000-0000-0045-000000000001' order by id$$,
 $$select row from historical_apps order by row->>'id'$$,
 'migration preserves complete historical app records, including identity, name, endpoint and domain choices');
select results_eq($$select to_jsonb(p) from amux.app_member_access p
 where app_id in (select (row->>'id')::uuid from historical_apps) order by app_id$$,
 $$select row from historical_access order by row->>'app_id'$$,
 'migration preserves complete referenced access records');

select is((select count(*)::integer from amux.apps where team_id = '00000000-0000-0000-0045-000000000001' and function_naming_mode = 'legacy'),
 5, 'all historical lifecycle states and code-domain apps remain legacy');
insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id)
 select team_id, created_by_actor_id, 'Old writer', 'function-mode-old-writer', type, org_id
 from amux.apps where slug = 'function-mode-never';
select is((select function_naming_mode from amux.apps where slug = 'function-mode-old-writer'), 'legacy', 'old writers omitting the mode get legacy');
select lives_ok($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, function_naming_mode)
 select team_id, created_by_actor_id, 'New', 'function-mode-new', type, org_id, 'app_code' from amux.apps where slug = 'function-mode-never'$$,
 'upgraded writers can explicitly insert app_code');
select is((select function_naming_mode from amux.apps where slug = 'function-mode-new'), 'app_code', 'explicit app_code is retained');
select throws_ok($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, function_naming_mode)
 select team_id, created_by_actor_id, 'Invalid', 'function-mode-invalid', type, org_id, 'unknown' from amux.apps where slug = 'function-mode-never'$$,
 '23514', null, 'unknown insert modes are rejected');
select throws_ok($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, org_id, function_naming_mode)
 select team_id, created_by_actor_id, 'Null', 'function-mode-null', type, org_id, null from amux.apps where slug = 'function-mode-never'$$,
 '23502', null, 'null insert modes are rejected');
select throws_ok($$update amux.apps set function_naming_mode = 'app_code' where slug = 'function-mode-never'$$,
 '23514', 'function_naming_mode is immutable', 'legacy cannot become app_code');
select throws_ok($$update amux.apps set function_naming_mode = 'legacy' where slug = 'function-mode-new'$$,
 '23514', 'function_naming_mode is immutable', 'app_code cannot become legacy');
select throws_ok($$update amux.apps set function_naming_mode = null where slug = 'function-mode-new'$$,
 '23514', 'function_naming_mode is immutable', 'updates cannot clear the mode');
select throws_ok($$update amux.apps set function_naming_mode = 'unknown' where slug = 'function-mode-new'$$,
 '23514', 'function_naming_mode is immutable', 'updates cannot introduce unknown modes');
select lives_ok($$update amux.apps set function_naming_mode = function_naming_mode where slug = 'function-mode-new'$$,
 'idempotent updates are allowed');
select lives_ok($$update amux.apps set name = '改名', slug = 'function-mode-renamed' where slug = 'function-mode-new'$$,
 'unrelated updates are allowed');
select is((select function_naming_mode from amux.apps where slug = 'function-mode-renamed'), 'app_code', 'rename retains mode');
select ok((select not prosecdef from pg_proc where oid = 'amux.keep_app_function_naming_mode_immutable()'::regprocedure),
 'immutability guard runs with invoker permissions');
select is((select proconfig::text from pg_proc where oid = 'amux.keep_app_function_naming_mode_immutable()'::regprocedure),
 '{search_path=pg_catalog}', 'guard uses a hardened search path');
select is((select count(*)::integer from amux.app_member_access where app_id in
 (select id from amux.apps where team_id = '00000000-0000-0000-0045-000000000001')), 5, 'data references retain their UUIDs');
select * from finish();
rollback;
