-- 20261102000000_agent_account_owner_roles.sql: a bot's account gets its
-- inviter's active roles in the team's org on every claim, added and never
-- duplicated; admin_type stays capped at 2.
begin;

select plan(7);

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Issue an agent invite from p_inviter (optionally a rebind of p_target),
-- claim it anonymously as the daemon does, return the agent actor.
create or replace function pg_temp.claim_agent(p_team uuid, p_inviter uuid, p_target uuid default null)
returns uuid language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_actor uuid;
begin
  insert into amux.team_invites (team_id, token, kind, agent_kind, display_name,
                                 invited_by_actor_id, expires_at, target_actor_id)
  values (p_team, v_token, 'agent', 'daemon', 'Bot', p_inviter, now() + interval '1 hour', p_target);
  perform pg_temp.as_anon();
  select actor_id into v_actor from amux.claim_team_invite(v_token);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v_actor;
end;
$$;

create or replace function pg_temp.bot_roles(p_agent uuid)
returns text[] language sql as $$
  select coalesce(array_agg(r.code order by r.code), '{}')
    from amux.actors a
    join public.roles_users ru on ru.user_id = a.user_id
    join public.roles r on r.id = ru.role_id
   where a.id = p_agent;
$$;

insert into public.orgs (id, name) values
  ('55aa0000-0000-4000-8000-000000000001', 'Owner Roles Gym'),
  ('55aa0000-0000-4000-8000-000000000002', 'Elsewhere');
insert into auth.users (id, email, aud, role, instance_id) values
  ('55bb0000-0000-4000-8000-000000000001', 'boss@owner-roles.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('55bb0000-0000-4000-8000-000000000002', 'guest@owner-roles.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('55bb0000-0000-4000-8000-000000000001', '55bb0000-0000-4000-8000-000000000001', '55aa0000-0000-4000-8000-000000000001', '13800005501', 4),
  ('55bb0000-0000-4000-8000-000000000002', '55bb0000-0000-4000-8000-000000000002', '55aa0000-0000-4000-8000-000000000001', '13800005502', 1);
insert into amux.teams (id, name, slug, oid) values
  ('55cc0000-0000-4000-8000-000000000001', 'owner-roles', 'owner-roles', '55aa0000-0000-4000-8000-000000000001');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('55dd0000-0000-4000-8000-000000000001', '55cc0000-0000-4000-8000-000000000001', 'member', '55bb0000-0000-4000-8000-000000000001', 'Boss'),
  ('55dd0000-0000-4000-8000-000000000002', '55cc0000-0000-4000-8000-000000000001', 'member', '55bb0000-0000-4000-8000-000000000002', 'Guest');
insert into amux.members (id, status) values
  ('55dd0000-0000-4000-8000-000000000001', 'active'),
  ('55dd0000-0000-4000-8000-000000000002', 'active');

insert into public.roles (id, name, code, org_id) values
  ('55ee0000-0000-4000-8000-000000000001', 'Reports', 't55_reports', '55aa0000-0000-4000-8000-000000000001'),
  ('55ee0000-0000-4000-8000-000000000002', 'Finance', 't55_finance', '55aa0000-0000-4000-8000-000000000001'),
  ('55ee0000-0000-4000-8000-000000000003', 'Retired', 't55_retired', '55aa0000-0000-4000-8000-000000000001'),
  ('55ee0000-0000-4000-8000-000000000004', 'Lapsed', 't55_lapsed', '55aa0000-0000-4000-8000-000000000001'),
  ('55ee0000-0000-4000-8000-000000000005', 'Foreign', 't55_foreign', '55aa0000-0000-4000-8000-000000000002'),
  ('55ee0000-0000-4000-8000-000000000006', 'Later', 't55_later', '55aa0000-0000-4000-8000-000000000001');
-- Boss: two live roles in the team's org, one inactive, one expired, one in
-- another org. Guest (admin_type 1) holds a role too.
insert into public.roles_users (user_id, role_id, org_id, status, expires_at, created_at) values
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000001', '55aa0000-0000-4000-8000-000000000001', 'active', null, now()),
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000002', '55aa0000-0000-4000-8000-000000000001', 'active', now() + interval '30 days', now()),
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000003', '55aa0000-0000-4000-8000-000000000001', 'inactive', null, now()),
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000004', '55aa0000-0000-4000-8000-000000000001', 'active', now() - interval '1 day', now() - interval '2 days'),
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000005', '55aa0000-0000-4000-8000-000000000002', 'active', null, now()),
  ('55bb0000-0000-4000-8000-000000000002', '55ee0000-0000-4000-8000-000000000001', '55aa0000-0000-4000-8000-000000000001', 'active', null, now());

create temp table t as
  select pg_temp.claim_agent('55cc0000-0000-4000-8000-000000000001', '55dd0000-0000-4000-8000-000000000001') as agent;

select is(pg_temp.bot_roles((select agent from t)), array['t55_finance', 't55_reports'],
          'a new bot gets its owner''s active, unexpired roles in the team''s org only');
select is((select ru.expires_at from public.roles_users ru
             join amux.actors a on a.user_id = ru.user_id
            where a.id = (select agent from t) and ru.role_id = '55ee0000-0000-4000-8000-000000000002'),
          (select expires_at from public.roles_users
            where user_id = '55bb0000-0000-4000-8000-000000000001' and role_id = '55ee0000-0000-4000-8000-000000000002'),
          'a copied role keeps its expiry');
select is((select u.admin_type::int from public.users u join amux.actors a on a.user_id = u.id where a.id = (select agent from t)),
          2, 'a bot of an admin_type 4 owner is still admin_type 2');

-- A role granted to the owner later reaches the bot at its next rotation,
-- and the roles it already holds are not duplicated.
insert into public.roles_users (user_id, role_id, org_id) values
  ('55bb0000-0000-4000-8000-000000000001', '55ee0000-0000-4000-8000-000000000006', '55aa0000-0000-4000-8000-000000000001');
select pg_temp.claim_agent('55cc0000-0000-4000-8000-000000000001', '55dd0000-0000-4000-8000-000000000001', (select agent from t));
select is(pg_temp.bot_roles((select agent from t)), array['t55_finance', 't55_later', 't55_reports'],
          'rotation adds roles granted since, without duplicates');

-- A role revoked from the owner is not taken from the bot.
delete from public.roles_users
 where user_id = '55bb0000-0000-4000-8000-000000000001' and role_id = '55ee0000-0000-4000-8000-000000000006';
select pg_temp.claim_agent('55cc0000-0000-4000-8000-000000000001', '55dd0000-0000-4000-8000-000000000001', (select agent from t));
select is(pg_temp.bot_roles((select agent from t)), array['t55_finance', 't55_later', 't55_reports'],
          'rotation never removes a role');

-- An inviter who is not staff of the team's org passes on nothing.
create temp table g as
  select pg_temp.claim_agent('55cc0000-0000-4000-8000-000000000001', '55dd0000-0000-4000-8000-000000000002') as agent;
select is(pg_temp.bot_roles((select agent from g)), '{}'::text[],
          'a non-staff inviter''s roles are not copied');
select is((select u.admin_type::int from public.users u join amux.actors a on a.user_id = u.id where a.id = (select agent from g)),
          1, 'a non-staff inviter''s bot is admin_type 1');

select * from finish();
rollback;
