-- services/supabase/tests/024_remove_team_actor_owned_agents.sql
-- Admin removing a member who owns agent(s) should cascade-delete those agents.
-- Post-S2: all business tables live in amux; remove_team_actor must too.
begin;

create or replace function pg_temp.as_member(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- amux.current_team_role reads public.roles_users, which is ORG-scoped, so a
-- fixture that seeds only amux.team_members.role leaves every actor at the
-- `member` floor. Give the team an org (creating one on the fly if it has
-- none — the orgs trigger seeds the four system roles) and the user a real
-- binding. See 20260915200000_org_roles.sql.
create or replace function pg_temp.grant_org_role(p_team uuid, p_user uuid, p_code text)
returns void language plpgsql as $$
declare
  v_org  uuid;
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

do $$
declare
  v_team        uuid := gen_random_uuid();
  v_owner_uid   uuid := gen_random_uuid();
  v_member_uid  uuid := gen_random_uuid();
  v_owner_mem   uuid := gen_random_uuid();
  v_member_mem  uuid := gen_random_uuid();
  v_agent_actor uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,  'owner-rm@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid, 'member-rm@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  insert into amux.teams (id, slug, name)
  values (v_team, 'rm-own-' || left(v_team::text, 8), 'Remove Owned Agents');

  -- actors first (members/agents.id FK → actors.id)
  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,  v_team, 'member', 'Owner',  v_owner_uid),
    (v_member_mem, v_team, 'member', 'Member', v_member_uid);

  insert into amux.members (id, status)
  values
    (v_owner_mem,  'active'),
    (v_member_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,  'owner'),
    (v_team, v_member_mem, 'member');

  perform pg_temp.grant_org_role(v_team, v_owner_uid,  'owner');
  perform pg_temp.grant_org_role(v_team, v_member_uid, 'member');

  insert into amux.actors (id, team_id, actor_type, display_name)
  values (v_agent_actor, v_team, 'agent', 'MemberAgent');

  insert into amux.agents (id, status, owner_member_id)
  values (v_agent_actor, 'active', v_member_mem);

  perform pg_temp.as_member(v_owner_uid);
  perform amux.remove_team_actor(v_member_mem);

  if exists (select 1 from amux.actors where id = v_member_mem) then
    raise exception 'member actor should be deleted';
  end if;

  if exists (select 1 from amux.actors where id = v_agent_actor) then
    raise exception 'owned agent actor should be deleted';
  end if;
end;
$$;

select plan(1);
select pass('remove_team_actor cascades owned agents when removing member');
select * from finish();
rollback;
