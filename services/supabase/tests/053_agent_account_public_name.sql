-- 20261027000000_agent_account_public_name.sql: an agent account's
-- public.users name and nickname are the agent actor's display name; rotation
-- fills blank ones in and never overwrites set ones.
begin;

select plan(5);

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Issue an agent invite from the team's member actor (optionally a rebind of
-- p_target), claim it anonymously as the daemon does, return the agent actor.
create or replace function pg_temp.claim_agent(p_team uuid, p_target uuid default null, p_name text default 'Bot')
returns uuid language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_actor uuid;
begin
  insert into amux.team_invites (team_id, token, kind, agent_kind, display_name,
                                 invited_by_actor_id, expires_at, target_actor_id)
  values (p_team, v_token, 'agent', 'daemon', p_name,
          (select id from amux.actors where team_id = p_team and actor_type = 'member'),
          now() + interval '1 hour', p_target);
  perform pg_temp.as_anon();
  select actor_id into v_actor from amux.claim_team_invite(v_token);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v_actor;
end;
$$;

insert into public.orgs (id, name) values ('53aa0000-0000-4000-8000-000000000001', 'Agent Name Gym');
insert into auth.users (id, email, aud, role, instance_id) values
  ('53bb0000-0000-4000-8000-000000000001', 'staff@agent-name.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('53bb0000-0000-4000-8000-000000000001', '53bb0000-0000-4000-8000-000000000001', '53aa0000-0000-4000-8000-000000000001', '13800005301', 2);
insert into amux.teams (id, name, slug, oid) values
  ('53cc0000-0000-4000-8000-000000000001', 'agent-name', 'agent-name', '53aa0000-0000-4000-8000-000000000001');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('53dd0000-0000-4000-8000-000000000001', '53cc0000-0000-4000-8000-000000000001', 'member', '53bb0000-0000-4000-8000-000000000001', 'Inviter');
insert into amux.members (id, status) values ('53dd0000-0000-4000-8000-000000000001', 'active');

create temp table t as select pg_temp.claim_agent('53cc0000-0000-4000-8000-000000000001', null, '前台小助手') as agent;
create temp view agent_user as
  select a.user_id from amux.actors a where a.id = (select agent from t);

select is((select display_name from amux.actors where id = (select agent from t)),
          '前台小助手', 'the agent actor is named from the invite');
select is((select name::text from public.users where id = (select user_id from agent_user)),
          '前台小助手', 'a new agent''s public.users name is the actor name');
select is((select nickname::text from public.users where id = (select user_id from agent_user)),
          '前台小助手', 'a new agent''s public.users nickname is the actor name');

-- A row from before this migration: name/nickname blank. Rotation fills them
-- in from the actor, not from the rebind invite's display_name.
update public.users set name = '', nickname = '' where id = (select user_id from agent_user);
select pg_temp.claim_agent('53cc0000-0000-4000-8000-000000000001', (select agent from t), 'Other');
select is((select array[name::text, nickname::text] from public.users where id = (select user_id from agent_user)),
          array['前台小助手', '前台小助手'],
          'rotation fills blank name and nickname in from the actor');

-- Values an operator set survive rotation.
update public.users set name = '张三', nickname = '小张' where id = (select user_id from agent_user);
select pg_temp.claim_agent('53cc0000-0000-4000-8000-000000000001', (select agent from t));
select is((select array[name::text, nickname::text] from public.users where id = (select user_id from agent_user)),
          array['张三', '小张'],
          'rotation never overwrites a set name or nickname');

select * from finish();
rollback;
