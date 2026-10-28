-- services/supabase/tests/054_remove_member_keeps_team_agents.sql
-- Removing a member hands their TEAM agents to the remover (so agents that
-- synced files no longer block the removal) and still deletes personal agents.
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
  v_team          uuid := gen_random_uuid();
  v_owner_uid     uuid := gen_random_uuid();
  v_member_uid    uuid := gen_random_uuid();
  v_blocked_uid   uuid := gen_random_uuid();
  v_owner_mem     uuid := gen_random_uuid();
  v_member_mem    uuid := gen_random_uuid();
  v_blocked_mem   uuid := gen_random_uuid();
  v_team_agent    uuid := gen_random_uuid();
  v_personal      uuid := gen_random_uuid();
  v_blocked_agent uuid := gen_random_uuid();
  v_file          uuid := gen_random_uuid();
  v_blocked_file  uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,   'owner-keep@amux.test',   'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid,  'member-keep@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_blocked_uid, 'blocked-keep@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  insert into amux.teams (id, slug, name)
  values (v_team, 'rm-keep-' || left(v_team::text, 8), 'Remove Keeps Team Agents');

  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,   v_team, 'member', 'Owner',   v_owner_uid),
    (v_member_mem,  v_team, 'member', 'Member',  v_member_uid),
    (v_blocked_mem, v_team, 'member', 'Blocked', v_blocked_uid);

  insert into amux.members (id, status)
  values (v_owner_mem, 'active'), (v_member_mem, 'active'), (v_blocked_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,   'owner'),
    (v_team, v_member_mem,  'member'),
    (v_team, v_blocked_mem, 'member');

  perform pg_temp.grant_org_role(v_team, v_owner_uid,   'owner');
  perform pg_temp.grant_org_role(v_team, v_member_uid,  'member');
  perform pg_temp.grant_org_role(v_team, v_blocked_uid, 'member');

  insert into amux.actors (id, team_id, actor_type, display_name)
  values
    (v_team_agent,    v_team, 'agent', 'TeamAgent'),
    (v_personal,      v_team, 'agent', 'PersonalAgent'),
    (v_blocked_agent, v_team, 'agent', 'BlockedPersonalAgent');

  insert into amux.agents (id, status, visibility, owner_member_id)
  values
    (v_team_agent,    'active', 'team',     v_member_mem),
    (v_personal,      'active', 'personal', v_member_mem),
    (v_blocked_agent, 'active', 'personal', v_blocked_mem);

  -- The team agent has synced a file: these rows reference its actor
  -- ON DELETE RESTRICT, which is what used to block the member's removal.
  insert into amux.amuxc_files (id, team_id, path, current_version, updated_by)
  values
    (v_file,         v_team, 'knowledge/a.md', 1, v_team_agent),
    (v_blocked_file, v_team, 'knowledge/b.md', 1, v_blocked_agent);
  insert into amux.amuxc_file_versions (file_id, version, parent_version, created_by)
  values
    (v_file,         1, 0, v_team_agent),
    (v_blocked_file, 1, 0, v_blocked_agent);

  perform pg_temp.as_member(v_owner_uid);
  perform amux.remove_team_actor(v_member_mem);

  if exists (select 1 from amux.actors where id = v_member_mem) then
    raise exception 'member actor should be deleted';
  end if;
  if exists (select 1 from amux.actors where id = v_personal) then
    raise exception 'personal agent should be deleted with its owner';
  end if;
  if not exists (
    select 1 from amux.agents
     where id = v_team_agent and owner_member_id = v_owner_mem
  ) then
    raise exception 'team agent should survive and be handed to the remover';
  end if;

  -- A personal agent with synced files still blocks, and must surface the
  -- stable token rather than the raw constraint error (PG 18 reports RESTRICT
  -- as restrict_violation, not foreign_key_violation).
  begin
    perform amux.remove_team_actor(v_blocked_mem);
    raise exception 'expected FK blocker for files';
  exception
    when others then
      if sqlerrm not ilike '%agent_delete_blocked_by_files%' then
        raise;
      end if;
  end;
end;
$$;

select plan(1);
select pass('remove_team_actor keeps team agents and maps RESTRICT blockers');
select * from finish();
rollback;
