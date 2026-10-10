begin;
select plan(14);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.grant_org_role(p_team uuid, p_user uuid, p_code text)
returns void language plpgsql as $$
declare
  v_org uuid;
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
  ('a3810001-0000-4000-8000-000000000001', 'join-link-alice@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('a3810001-0000-4000-8000-000000000002', 'join-link-bob@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('a3810001-0000-4000-8000-000000000003', 'join-link-carol@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('a3810001-0000-4000-8000-000000000004', 'join-link-dave@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a3810001-0000-4000-8000-000000000001');
select * from amux.create_team('Join Link Team', p_oid => null);

create temp table ctx as
  select
    (select id from amux.teams where slug = 'join-link-team') as team_id,
    (select oid from amux.teams where slug = 'join-link-team') as org_id;
grant select on ctx to anon, authenticated;

reset role;
select pg_temp.grant_org_role(
  (select team_id from ctx),
  'a3810001-0000-4000-8000-000000000001',
  'owner');
select pg_temp.grant_org_role(
  (select team_id from ctx),
  'a3810001-0000-4000-8000-000000000002',
  'member');

update ctx set org_id = (select oid from amux.teams where id = (select team_id from ctx));

-- Table is RLS-on with no policies and no SELECT grant; fixtures read through
-- security-definer helpers the same way the RPCs do.
create or replace function pg_temp.active_token()
returns text language sql security definer set search_path to amux, public as $$
  select token from amux.team_join_links
   where team_id = (select team_id from ctx) and revoked_at is null
$$;

create or replace function pg_temp.token_use_count(p_token text)
returns int language sql security definer set search_path to amux, public as $$
  select use_count from amux.team_join_links where token = p_token
$$;

select pg_temp.as_user('a3810001-0000-4000-8000-000000000002');
select throws_ok(
  format($$ select * from amux.put_team_join_link(%L::uuid, '7d', null, false, null) $$,
         (select team_id from ctx)),
  '42501', 'team owner or admin access required',
  'member cannot mint');

select pg_temp.as_user('a3810001-0000-4000-8000-000000000001');
select throws_ok(
  format($$ select * from amux.put_team_join_link(%L::uuid, '7d', null, false, %L::uuid) $$,
         (select team_id from ctx), (select org_id from ctx)),
  '42501', '升级账号后才能邀请成员加入团队',
  'default org cannot mint');

create temp table link as
  select * from amux.put_team_join_link((select team_id from ctx), '7d', null, false, null);
grant select on link to anon, authenticated;

select ok(
  (select expires_at from link) > now() + interval '6 days'
  and (select expires_at from link) < now() + interval '8 days',
  '7d expiry is about seven days out');

select pg_temp.as_user('a3810001-0000-4000-8000-000000000003');
create temp table joined as
  select * from amux.join_team_by_link((select token from link));
grant select on joined to anon, authenticated;
select ok((select already_member from joined) = false, 'first join is a new member');
select is(pg_temp.token_use_count((select token from link)), 1,
          'use_count increments once');

create temp table again as
  select * from amux.join_team_by_link((select token from link));
select ok((select already_member from again) = true, 'second join is already a member');
select is(pg_temp.token_use_count((select token from link)), 1,
          'already-member does not increment');

select pg_temp.as_user('a3810001-0000-4000-8000-000000000001');
select * from amux.put_team_join_link((select team_id from ctx), 'never', 1, true, null);
select is(
  (select status from amux.preview_team_join_link((select token from link))),
  'revoked',
  'rotated token previews as revoked');

select throws_ok(
  format($$ select * from amux.join_team_by_link(%L) $$, (select token from link)),
  'P0001', 'link_revoked',
  'revoked token cannot join');

select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$ select * from amux.join_team_by_link('no-such-token') $$,
  '42501', 'join_team_by_link requires an authenticated user',
  'anonymous join is rejected');

select pg_temp.as_user('a3810001-0000-4000-8000-000000000004');
select lives_ok(
  format($$ select * from amux.join_team_by_link(%L) $$,
         pg_temp.active_token()),
  'first joiner fits under max_uses 1');

reset role;
insert into auth.users (id, email, aud, role, instance_id) values
  ('a3810001-0000-4000-8000-000000000005', 'join-link-erin@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;
select pg_temp.as_user('a3810001-0000-4000-8000-000000000005');
select throws_ok(
  format($$ select * from amux.join_team_by_link(%L) $$,
         pg_temp.active_token()),
  'P0001', 'link_exhausted',
  'second new member is exhausted');

select pg_temp.as_user('a3810001-0000-4000-8000-000000000001');
select * from amux.put_team_join_link((select team_id from ctx), '7d', null, true, null);
reset role;
update amux.team_join_links
   set expires_at = now() - interval '1 minute'
 where team_id = (select team_id from ctx) and revoked_at is null;
select pg_temp.as_user('a3810001-0000-4000-8000-000000000005');
select throws_ok(
  format($$ select * from amux.join_team_by_link(%L) $$,
         pg_temp.active_token()),
  'P0001', 'link_expired',
  'expired link cannot join');
reset role;
select is(
  (select amux.team_join_link_status(null, now() + interval '30 days', null, 0)),
  'active',
  '30d-shaped expiry is active');

select * from finish();
rollback;
