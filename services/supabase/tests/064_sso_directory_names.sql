-- 20261127090000_sso_directory_apps.sql: a directory name replaces an SSO
-- account's placeholder name, and only that.
begin;

select plan(13);

create or replace function pg_temp.raises_sqlstate(p_sql text, p_expected_sqlstate text)
returns boolean language plpgsql as $$
declare v_sqlstate text;
begin
  execute p_sql;
  return false;
exception when others then
  get stacked diagnostics v_sqlstate = returned_sqlstate;
  return v_sqlstate = p_expected_sqlstate;
end;
$$;

insert into public.orgs (id, name) values ('64aa0000-0000-4000-8000-000000000001', 'Corp D org');
insert into amux.sso_org_bindings (provider, tenant_id, org_id, tenant_name)
values ('wecom', 'wwcorpD', '64aa0000-0000-4000-8000-000000000001', 'Corp D');

create temp table t (anon_id uuid, named_id uuid);
insert into t (anon_id) select amux.ensure_sso_identity('wecom', 'wwcorpD', 'open_d1', null);
update t set named_id = amux.ensure_sso_identity('wecom', 'wwcorpD', 'open_d2', 'Bob');

-- One team where the placeholder person is a member under the placeholder
-- name, and another where they already renamed themselves.
insert into amux.teams (id, slug, name) values
  ('64bb0000-0000-4000-8000-000000000001', 'sso-dir-1', 'Dir 1'),
  ('64bb0000-0000-4000-8000-000000000002', 'sso-dir-2', 'Dir 2');
insert into amux.actors (id, team_id, actor_type, display_name, user_id)
select '64cc0000-0000-4000-8000-000000000001', '64bb0000-0000-4000-8000-000000000001', 'member',
       (select nickname from public.users where auth_user_id = t.anon_id), t.anon_id from t;
insert into amux.actors (id, team_id, actor_type, display_name, user_id)
select '64cc0000-0000-4000-8000-000000000002', '64bb0000-0000-4000-8000-000000000002', 'member',
       '我自己起的名', t.anon_id from t;

select ok(amux.sso_is_placeholder_name('企业微信用户 aa40'), 'the fallback name is a placeholder');
select ok(not amux.sso_is_placeholder_name('企业微信用户 张三'), 'a real name is not');
select ok(not amux.sso_is_placeholder_name(null), 'null is not');

select is(
  (select array_agg(subject order by subject) from amux.sso_identities_needing_name('wecom', 'wwcorpD')),
  array['open_d1'],
  'only the identity still on the placeholder needs a name');

select ok(amux.sso_apply_directory_name((select anon_id from t), '  张三 '), 'applying a directory name reports a change');
select is(
  (select nickname from public.users where auth_user_id = (select anon_id from t)), '张三',
  'the profile placeholder is replaced (trimmed)');
select is(
  (select display_name from amux.actors where id = '64cc0000-0000-4000-8000-000000000001'), '张三',
  'the team member placeholder is replaced');
select is(
  (select display_name from amux.actors where id = '64cc0000-0000-4000-8000-000000000002'), '我自己起的名',
  'a name the person chose is kept');
select ok(not amux.sso_apply_directory_name((select anon_id from t), '李四'), 'a second apply changes nothing');
select is(
  (select count(*)::int from amux.sso_identities_needing_name('wecom', 'wwcorpD')), 0,
  'nobody needs a name any more');

select ok(
  pg_temp.raises_sqlstate(
    $$select amux.sso_apply_directory_name('64dd0000-0000-4000-8000-0000000000ff', 'x')$$, '42501'),
  'an account that is not an SSO identity is refused');

-- Unbinding the company drops its directory app.
insert into amux.sso_directory_apps (provider, tenant_id, permanent_code)
values ('wecom', 'wwcorpD', 'secret');
delete from amux.sso_org_bindings where provider = 'wecom' and tenant_id = 'wwcorpD';
select is(
  (select count(*)::int from amux.sso_directory_apps where tenant_id = 'wwcorpD'), 0,
  'unbinding the company drops its directory app');

select ok(
  not has_table_privilege('authenticated', 'amux.sso_directory_apps', 'select')
  and not has_function_privilege('authenticated', 'amux.sso_apply_directory_name(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'amux.sso_identities_needing_name(text,text)', 'execute'),
  'clients cannot reach the directory table or RPCs');

select * from finish();
rollback;
