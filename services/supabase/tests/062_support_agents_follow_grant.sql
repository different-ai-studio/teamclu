-- 20261123120000_support_agents_follow_grant.sql: an agent set up by a support
-- account works only while the support grant it was bound under is live.
begin;

select plan(14);

create or replace function pg_temp.as_user(p_user uuid, p_session uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated',
                      'session_id', coalesce(p_session::text, ''))::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_owner()
returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

insert into public.orgs (id, name) values
  ('62aa0000-0000-4000-8000-00000000000a', 'Platform'),
  ('62aa0000-0000-4000-8000-00000000000c', 'Customer');
insert into auth.users (id, email, aud, role, instance_id) values
  ('62bb0000-0000-4000-8000-000000000001', 'op1@supbot.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('62bb0000-0000-4000-8000-000000000005', 'cust@supbot.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('62bb0000-0000-4000-8000-0000000000b1', 'daemon.b1@amuxd.run', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('62bb0000-0000-4000-8000-0000000000b2', 'daemon.b2@amuxd.run', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('62bb0000-0000-4000-8000-000000000001', '62bb0000-0000-4000-8000-000000000001', '62aa0000-0000-4000-8000-00000000000a', '13800006201', 4),
  ('62bb0000-0000-4000-8000-000000000005', '62bb0000-0000-4000-8000-000000000005', '62aa0000-0000-4000-8000-00000000000c', '', 3);
insert into amux.teams (id, name, slug, oid) values
  ('62cc0000-0000-4000-8000-00000000000c', 'customer', 'customer-62', '62aa0000-0000-4000-8000-00000000000c');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('62dd0000-0000-4000-8000-000000000005', '62cc0000-0000-4000-8000-00000000000c', 'member', '62bb0000-0000-4000-8000-000000000005', 'Customer');
insert into amux.members (id, status) values ('62dd0000-0000-4000-8000-000000000005', 'active');

insert into amux.deployment_settings (key, value)
values ('platform_org_id', '"62aa0000-0000-4000-8000-00000000000a"')
on conflict (key) do update set value = excluded.value;

select ok(not has_function_privilege('authenticated', 'amux.support_agent_access_live(uuid)', 'execute'),
          'clients cannot probe support bots');
select ok(not has_table_privilege('authenticated', 'amux.support_agents', 'select'),
          'clients cannot read support_agents');

create temp table s1 on commit drop as
  select * from amux.start_support_session('62bb0000-0000-4000-8000-000000000001', '62cc0000-0000-4000-8000-00000000000c', 'ticket 1');
grant select on s1 to authenticated;

-- ── binding ────────────────────────────────────────────────────────────────
select pg_temp.as_user((select support_user_id from s1), (select session_id from s1));
create temp table bind1 on commit drop as
  select * from amux.ensure_agent_for_device('62cc0000-0000-4000-8000-00000000000c', 'device-op1', 'TeamClu 支持Bot');
select pg_temp.as_owner();

select ok((select created from bind1), 'the support account gets an agent for the machine');
select is((select grant_id from amux.support_agents where agent_id = (select agent_id from bind1)),
          (select grant_id from s1), 'bound to the grant of the session that set it up');

-- The daemon's claim gives the agent an account; stand that in directly.
update amux.actors set user_id = '62bb0000-0000-4000-8000-0000000000b1' where id = (select agent_id from bind1);

select ok(amux.support_agent_access_live('62bb0000-0000-4000-8000-0000000000b1'), 'the bot works while the grant is live');

select pg_temp.as_user('62bb0000-0000-4000-8000-0000000000b1');
select lives_ok($$ select amux.check_support_request() $$, 'the hook lets the bot through while the grant is live');
select pg_temp.as_owner();

-- A member's own agent is untouched.
select pg_temp.as_user('62bb0000-0000-4000-8000-000000000005');
create temp table bind_cust on commit drop as
  select * from amux.ensure_agent_for_device('62cc0000-0000-4000-8000-00000000000c', 'device-cust', 'CustomerBot');
select pg_temp.as_owner();
update amux.actors set user_id = '62bb0000-0000-4000-8000-0000000000b2' where id = (select agent_id from bind_cust);
select ok(not exists (select 1 from amux.support_agents where agent_id = (select agent_id from bind_cust)),
          'a member''s agent is not a support agent');

-- ── the grant ends ─────────────────────────────────────────────────────────
select ok(amux.end_support_session((select support_user_id from s1), (select session_id from s1)), 'the operator leaves');

select ok(not amux.support_agent_access_live('62bb0000-0000-4000-8000-0000000000b1'), 'the bot stops working with its grant');
select pg_temp.as_user('62bb0000-0000-4000-8000-0000000000b1');
select throws_ok($$ select amux.check_support_request() $$, '42501', 'support session ended',
                 'the hook refuses the bot once its grant has ended');
select pg_temp.as_owner();

select pg_temp.as_user('62bb0000-0000-4000-8000-0000000000b2');
select lives_ok($$ select amux.check_support_request() $$, 'a member''s bot is never refused');
select pg_temp.as_owner();

-- A dead support session cannot rebind.
select pg_temp.as_user((select support_user_id from s1), (select session_id from s1));
select throws_ok($$ select * from amux.ensure_agent_for_device('62cc0000-0000-4000-8000-00000000000c', 'device-op1', 'x') $$,
                 '42501', null, 'an ended support session cannot rebind the bot');
select pg_temp.as_owner();

-- ── entering again ─────────────────────────────────────────────────────────
create temp table s2 on commit drop as
  select * from amux.start_support_session('62bb0000-0000-4000-8000-000000000001', '62cc0000-0000-4000-8000-00000000000c', 'ticket 2');
select pg_temp.as_user((select support_user_id from s2), (select session_id from s2));
create temp table bind2 on commit drop as
  select * from amux.ensure_agent_for_device('62cc0000-0000-4000-8000-00000000000c', 'device-op1', 'ignored');
select pg_temp.as_owner();

select is((select agent_id from bind2), (select agent_id from bind1), 'entering again finds the same bot');
select ok(amux.support_agent_access_live('62bb0000-0000-4000-8000-0000000000b1'), 'rebound onto the new grant, it works again');

select * from finish();
rollback;
