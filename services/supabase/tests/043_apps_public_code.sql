begin;
select plan(13);

select has_column('amux', 'apps', 'app_code', 'apps have a public code');
select col_not_null('amux', 'apps', 'app_code', 'every app must have a code');
select has_column('amux', 'apps', 'uses_app_code_domain', 'domain activation is separate from code assignment');
select has_column('amux', 'apps', 'deploy_use_app_code_domain', 'the deploy attempt records its requested mode');
select ok(amux.generate_app_code() ~ '^a-[0-9a-hjkmnp-tv-z]{12}$', 'codes include the prefix and 12 DNS-safe Base32 characters');

insert into public.orgs(id, name)
values ('00000000-0000-0000-0043-000000000005', 'App codes org');
insert into amux.teams(id, slug, name, oid)
values ('00000000-0000-0000-0043-000000000001', 'app-code-test', 'App codes', '00000000-0000-0000-0043-000000000005');
insert into auth.users(id, email, aud, role, instance_id)
values ('00000000-0000-0000-0043-000000000004', 'app-code-owner@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into amux.actors(id, team_id, actor_type, user_id, display_name)
values ('00000000-0000-0000-0043-000000000002', '00000000-0000-0000-0043-000000000001', 'member', '00000000-0000-0000-0043-000000000004', 'Owner');
insert into amux.members(id, status) values ('00000000-0000-0000-0043-000000000002', 'active');
insert into amux.apps(id, team_id, created_by_actor_id, name, slug, type, org_id)
values ('00000000-0000-0000-0043-000000000003', '00000000-0000-0000-0043-000000000001', '00000000-0000-0000-0043-000000000002', '门店大盘', 'app-code-test', 'static_web', '00000000-0000-0000-0043-000000000005');

select ok((select app_code ~ '^a-[0-9a-hjkmnp-tv-z]{12}$' from amux.apps where slug = 'app-code-test'), 'new apps receive a code automatically');
select ok((select uses_app_code_domain from amux.apps where slug = 'app-code-test'), 'new apps default to code domains');
create temporary table saved_app_code as select id, app_code from amux.apps where slug = 'app-code-test';
update amux.apps set name = 'Renamed' where slug = 'app-code-test';
select is((select app_code from amux.apps where slug = 'app-code-test'), (select app_code from saved_app_code), 'renaming preserves the code');
select throws_ok($$update amux.apps set app_code = 'a-000000000000' where slug = 'app-code-test'$$, '23514', 'app_code is immutable', 'the code cannot be reassigned');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, app_code, org_id)
select team_id, created_by_actor_id, 'Duplicate', 'duplicate-app-code', type, app_code, org_id from amux.apps where slug = 'app-code-test'$$,
'%apps_app_code_key%', 'duplicate codes are rejected');

select ok((select deploy_use_app_code_domain is null from amux.apps where slug = 'app-code-test'), 'new apps have no pending deployment domain choice');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, app_code, org_id)
select team_id, created_by_actor_id, 'Malformed', 'malformed-app-code', type, 'bad', org_id from amux.apps where slug = 'app-code-test'$$,
'%apps_app_code_format%', 'malformed codes are rejected');
select throws_like($$insert into amux.apps(team_id, created_by_actor_id, name, slug, type, app_code, org_id)
select team_id, created_by_actor_id, 'Null code', 'null-app-code', type, null, org_id from amux.apps where slug = 'app-code-test'$$,
'%null value in column "app_code"%', 'explicit null codes are rejected');

select * from finish();
rollback;
