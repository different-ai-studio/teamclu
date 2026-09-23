-- services/supabase/tests/025_agent_delete_authz.sql
-- Personal agents: owner_member only. Team agents: owner/admin.
-- FK blockers surface stable error tokens.
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
  v_team           uuid := gen_random_uuid();
  v_owner_uid      uuid := gen_random_uuid();
  v_member_uid     uuid := gen_random_uuid();
  v_admin_uid      uuid := gen_random_uuid();
  v_owner_mem      uuid := gen_random_uuid();
  v_member_mem     uuid := gen_random_uuid();
  v_admin_mem      uuid := gen_random_uuid();
  v_personal_agent uuid := gen_random_uuid();
  v_team_agent     uuid := gen_random_uuid();
  v_idea_id        uuid := gen_random_uuid();
  v_apps_agent     uuid := gen_random_uuid();
  v_org            uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,  'del-owner@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid, 'del-member@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_admin_uid,  'del-admin@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  -- The team needs an org because the app below carries one: amux.apps.org_id
  -- is NOT NULL with an FK to public.orgs (20260923200000 / 20260924100000).
  insert into public.orgs (id, name)
  values (v_org, 'Agent Delete Authz Org');

  insert into amux.teams (id, slug, name, oid)
  values (v_team, 'del-auth-' || left(v_team::text, 8), 'Agent Delete Authz', v_org);

  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,  v_team, 'member', 'Owner',  v_owner_uid),
    (v_member_mem, v_team, 'member', 'Member', v_member_uid),
    (v_admin_mem,  v_team, 'member', 'Admin',  v_admin_uid);

  insert into amux.members (id, status)
  values
    (v_owner_mem,  'active'),
    (v_member_mem, 'active'),
    (v_admin_mem,  'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,  'owner'),
    (v_team, v_member_mem, 'member'),
    (v_team, v_admin_mem,  'admin');

  perform pg_temp.grant_org_role(v_team, v_owner_uid,  'owner');
  perform pg_temp.grant_org_role(v_team, v_member_uid, 'member');
  perform pg_temp.grant_org_role(v_team, v_admin_uid,  'admin');

  insert into amux.actors (id, team_id, actor_type, display_name)
  values
    (v_personal_agent, v_team, 'agent', 'Personal Bot'),
    (v_team_agent,     v_team, 'agent', 'Team Bot');

  insert into amux.agents (id, status, visibility, owner_member_id)
  values
    (v_personal_agent, 'active', 'personal', v_member_mem),
    (v_team_agent,     'active', 'team',     v_member_mem);

  -- Non-owner cannot delete a personal agent -- not even the team owner. The
  -- fixture hands this agent to v_member_mem, so the denial has to be probed as
  -- somebody else; probing it as v_member_uid (as this did) impersonated the
  -- agent's own owner, deleted the agent, and then reported the missing denial.
  perform pg_temp.as_member(v_owner_uid);
  begin
    perform amux.remove_team_actor(v_personal_agent);
    raise exception 'expected personal-agent delete denial for non-owner';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not ilike '%requires agent owner for personal agents%' then
        raise;
      end if;
  end;

  -- The agent's own owner can delete it.
  perform pg_temp.as_member(v_member_uid);
  perform amux.remove_team_actor(v_personal_agent);
  if exists (select 1 from amux.actors where id = v_personal_agent) then
    raise exception 'personal agent should be deleted by owner';
  end if;

  -- Regular member cannot delete team agent.
  perform pg_temp.as_member(v_member_uid);
  begin
    perform amux.remove_team_actor(v_team_agent);
    raise exception 'expected team-agent delete denial for member';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not ilike '%requires owner or admin for team agents%' then
        raise;
      end if;
  end;

  -- Admin can delete team agent.
  perform pg_temp.as_member(v_admin_uid);
  perform amux.remove_team_actor(v_team_agent);
  if exists (select 1 from amux.actors where id = v_team_agent) then
    raise exception 'team agent should be deleted by admin';
  end if;

  -- FK blocker: idea activity referencing agent actor.
  -- Seed the blocker fixtures as the session role: actors/agents INSERT is
  -- policy-scoped to the caller, and we are still impersonating a member from
  -- the assertions above.
  execute 'reset role';
  insert into amux.actors (id, team_id, actor_type, display_name)
  values (v_team_agent, v_team, 'agent', 'Blocked Bot');

  insert into amux.agents (id, status, visibility, owner_member_id)
  values (v_team_agent, 'active', 'team', v_member_mem);

  insert into amux.ideas (id, team_id, title, status, created_by_actor_id)
  values (v_idea_id, v_team, 'Blocked idea', 'open', v_owner_mem);

  insert into amux.idea_activities (team_id, idea_id, actor_id, activity_type, content)
  values (v_team, v_idea_id, v_team_agent, 'progress', 'still referenced');

  perform pg_temp.as_member(v_admin_uid);
  begin
    perform amux.remove_team_actor(v_team_agent);
    raise exception 'expected FK blocker for idea activity';
  exception
    when others then
      if sqlerrm not ilike '%agent_delete_blocked_by_idea_activities%' then
        raise;
      end if;
  end;

  -- FK blocker: app created_by_actor referencing agent.
  execute 'reset role';
  insert into amux.actors (id, team_id, actor_type, display_name)
  values (v_apps_agent, v_team, 'agent', 'Apps Blocked Bot');

  insert into amux.agents (id, status, visibility, owner_member_id)
  values (v_apps_agent, 'active', 'team', v_member_mem);

  -- org_id is NOT NULL (20260924100000): it is the app's tenant, and every
  -- app has one. Taken from the team, which is what createApp does.
  insert into amux.apps (team_id, created_by_actor_id, name, slug, type, org_id)
  values (v_team, v_apps_agent, 'Blocked App', 'blocked-app', 'static_web', v_org);

  perform pg_temp.as_member(v_admin_uid);
  begin
    perform amux.remove_team_actor(v_apps_agent);
    raise exception 'expected FK blocker for apps';
  exception
    when others then
      if sqlerrm not ilike '%agent_delete_blocked_by_apps%' then
        raise;
      end if;
  end;
end;
$$;

select plan(3);

select has_column('amux', 'actor_directory', 'owner_member_id',
  'actor_directory exposes owner_member_id for client delete gating');

select pass('remove_team_actor enforces personal/team authz and FK blockers');

select pass('remove_team_actor surfaces agent_delete_blocked_by_apps');

select * from finish();
rollback;
