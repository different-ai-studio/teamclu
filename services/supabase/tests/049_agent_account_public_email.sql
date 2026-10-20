-- 20261009000000_agent_account_public_email.sql: an agent account's
-- public.users row carries its login email; rotation fills a blank one in and
-- never overwrites a set one.
begin;

select plan(4);

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Issue an agent invite from the team's member actor (optionally a rebind of
-- p_target), claim it anonymously as the daemon does, return the agent actor.
create or replace function pg_temp.claim_agent(p_team uuid, p_target uuid default null)
returns uuid language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_actor uuid;
begin
  insert into amux.team_invites (team_id, token, kind, agent_kind, display_name,
                                 invited_by_actor_id, expires_at, target_actor_id)
  values (p_team, v_token, 'agent', 'daemon', 'Bot',
          (select id from amux.actors where team_id = p_team and actor_type = 'member'),
          now() + interval '1 hour', p_target);
  perform pg_temp.as_anon();
  select actor_id into v_actor from amux.claim_team_invite(v_token);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v_actor;
end;
$$;

insert into public.orgs (id, name) values ('49aa0000-0000-4000-8000-000000000001', 'Agent Email Gym');
insert into auth.users (id, email, aud, role, instance_id) values
  ('49bb0000-0000-4000-8000-000000000001', 'staff@agent-email.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('49bb0000-0000-4000-8000-000000000001', '49bb0000-0000-4000-8000-000000000001', '49aa0000-0000-4000-8000-000000000001', '13800004901', 2);
insert into amux.teams (id, name, slug, oid) values
  ('49cc0000-0000-4000-8000-000000000001', 'agent-email', 'agent-email', '49aa0000-0000-4000-8000-000000000001');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('49dd0000-0000-4000-8000-000000000001', '49cc0000-0000-4000-8000-000000000001', 'member', '49bb0000-0000-4000-8000-000000000001', 'Inviter');
insert into amux.members (id, status) values ('49dd0000-0000-4000-8000-000000000001', 'active');

create temp table t as select pg_temp.claim_agent('49cc0000-0000-4000-8000-000000000001') as agent;
create temp view agent_user as
  select a.user_id from amux.actors a where a.id = (select agent from t);

select is((select email::text from public.users where id = (select user_id from agent_user)),
          'daemon.' || (select user_id from agent_user)::text || '@amuxd.run',
          'a new agent''s public.users row carries its login email');
select is((select email::text from public.users where id = (select user_id from agent_user)),
          (select email::text from auth.users where id = (select user_id from agent_user)),
          'the same email auth.users has');

-- A row from before this migration: email blank. Rotation fills it in.
update public.users set email = '' where id = (select user_id from agent_user);
select pg_temp.claim_agent('49cc0000-0000-4000-8000-000000000001', (select agent from t));
select is((select email::text from public.users where id = (select user_id from agent_user)),
          'daemon.' || (select user_id from agent_user)::text || '@amuxd.run',
          'rotation fills a blank email in');

-- An email an operator set survives rotation.
update public.users set email = 'bot@gym.test' where id = (select user_id from agent_user);
select pg_temp.claim_agent('49cc0000-0000-4000-8000-000000000001', (select agent from t));
select is((select email::text from public.users where id = (select user_id from agent_user)),
          'bot@gym.test',
          'rotation never overwrites a set email');

select * from finish();
rollback;
