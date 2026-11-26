-- 20261126120000_enterprise_sso.sql: a WeCom user of a bound corp signs in as
-- a member identity of the bound org, minted once and reused after.
begin;

select plan(16);

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

insert into public.orgs (id, name) values
  ('63aa0000-0000-4000-8000-000000000001', 'Corp A org'),
  ('63aa0000-0000-4000-8000-000000000002', 'Corp A new org');

insert into amux.sso_org_bindings (provider, tenant_id, org_id, tenant_name)
values ('wecom', 'wwcorpA', '63aa0000-0000-4000-8000-000000000001', 'Corp A');

create temp table t (first uuid, again uuid, other uuid);
grant select on t to anon, authenticated;
insert into t (first) select amux.ensure_sso_identity('wecom', 'wwcorpA', 'open_u1', 'Alice');
update t set again = amux.ensure_sso_identity('wecom', 'wwcorpA', 'open_u1', 'Alice');
update t set other = amux.ensure_sso_identity('wecom', 'wwcorpA', 'open_u2', null);

select ok((select first is not null from t), 'first sign-in mints an identity');
select is((select again from t), (select first from t), 'second sign-in reuses it');
select isnt((select other from t), (select first from t), 'another person gets their own identity');

select is(
  (select admin_type::int from public.users where id = (select first from t)), 2,
  'the identity is a member (admin_type 2)');
select is(
  (select org_id from public.users where id = (select first from t)),
  '63aa0000-0000-4000-8000-000000000001'::uuid,
  'in the bound org');
select is(
  (select nickname from public.users where id = (select first from t)), 'Alice',
  'nickname carried over');
select ok(
  (select nickname ~ '^企业微信用户 [0-9a-f]{4}$' from public.users where id = (select other from t)),
  'a person without a name gets a readable placeholder, not their uuid');
select is(
  (select email::text from auth.users where id = (select first from t)),
  (select first from t)::text || '@teamclu.wecom',
  'synthetic <id>@teamclu.wecom account');
select ok(
  (select last_login_at is not null from amux.sso_identities where user_id = (select first from t)),
  'last_login_at stamped');

select ok(
  pg_temp.raises_sqlstate($$select amux.ensure_sso_identity('wecom', 'wwUnbound', 'open_u1')$$, 'P0002'),
  'an unbound corp is refused with P0002');
select ok(
  pg_temp.raises_sqlstate($$select amux.ensure_sso_identity('wecom', 'wwcorpA', '  ')$$, '22023'),
  'a blank subject is refused');

-- Rebinding the corp to another org gives the person a new identity there and
-- leaves the old one alone.
update amux.sso_org_bindings set org_id = '63aa0000-0000-4000-8000-000000000002'
 where provider = 'wecom' and tenant_id = 'wwcorpA';
select isnt(
  amux.ensure_sso_identity('wecom', 'wwcorpA', 'open_u1', 'Alice'),
  (select first from t),
  'after a rebind the person signs in as a new identity in the new org');

select ok(
  amux.sso_mint_session((select first from t)) is not null,
  'sso_mint_session mints a refresh token for an SSO identity');
select ok(
  pg_temp.raises_sqlstate(
    $$select amux.sso_mint_session('63bb0000-0000-4000-8000-0000000000ff')$$, '42501'),
  'sso_mint_session refuses an account that is not an SSO identity');

select ok(
  not has_function_privilege('authenticated', 'amux.ensure_sso_identity(text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'amux.ensure_sso_identity(text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'amux.sso_mint_session(uuid)', 'execute'),
  'clients cannot call the SSO RPCs');
select ok(
  not has_table_privilege('authenticated', 'amux.sso_org_bindings', 'select')
  and not has_table_privilege('authenticated', 'amux.sso_flows', 'select')
  and not has_table_privilege('anon', 'amux.sso_suite_tickets', 'select'),
  'clients cannot read the SSO tables');

select * from finish();
rollback;
