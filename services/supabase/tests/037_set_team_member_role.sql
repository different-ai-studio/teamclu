-- services/supabase/tests/037_set_team_member_role.sql
-- Owner/admin can promote a member to admin and demote an admin to member.
-- Cannot change own role, cannot change owner, members cannot change anyone.
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
  v_admin_uid   uuid := gen_random_uuid();
  v_member_uid  uuid := gen_random_uuid();
  v_owner_mem   uuid := gen_random_uuid();
  v_admin_mem   uuid := gen_random_uuid();
  v_member_mem  uuid := gen_random_uuid();
  v_role        text;
  v_def         text;
begin
  v_def := pg_get_functiondef('amux.set_team_member_role(uuid,text)'::regprocedure);
  if v_def like '%amux.current_actor_id()%' then
    raise exception 'set_team_member_role must not call dropped amux.current_actor_id()';
  end if;

  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,  'role-owner@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_admin_uid,  'role-admin@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid, 'role-member@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  insert into amux.teams (id, slug, name)
  values (v_team, 'set-role-' || left(v_team::text, 8), 'Set Member Role');

  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,  v_team, 'member', 'Owner',  v_owner_uid),
    (v_admin_mem,  v_team, 'member', 'Admin',  v_admin_uid),
    (v_member_mem, v_team, 'member', 'Member', v_member_uid);

  insert into amux.members (id, status)
  values
    (v_owner_mem,  'active'),
    (v_admin_mem,  'active'),
    (v_member_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,  'owner'),
    (v_team, v_admin_mem,  'admin'),
    (v_team, v_member_mem, 'member');

  -- The caller checks read amux.current_team_role, i.e. roles_users. Without
  -- these bindings every actor sits at the `member` floor, and this file only
  -- passed while a NULL role still slipped past `not in ('owner','admin')`.
  perform pg_temp.grant_org_role(v_team, v_owner_uid,  'owner');
  perform pg_temp.grant_org_role(v_team, v_admin_uid,  'admin');
  perform pg_temp.grant_org_role(v_team, v_member_uid, 'member');

  -- Regular member cannot promote anyone.
  perform pg_temp.as_member(v_member_uid);
  begin
    perform amux.set_team_member_role(v_member_mem, 'admin');
    raise exception 'expected member self-promote denial';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not ilike '%cannot change your own role%'
         and sqlerrm not ilike '%requires owner or admin%' then
        raise;
      end if;
  end;

  -- Admin can promote a member.
  perform pg_temp.as_member(v_admin_uid);
  perform amux.set_team_member_role(v_member_mem, 'admin');
  select role into v_role from amux.team_members
   where team_id = v_team and member_id = v_member_mem;
  if v_role is distinct from 'admin' then
    raise exception 'member should have been promoted to admin, got %', v_role;
  end if;

  -- Admin can demote another admin (the one just promoted).
  perform amux.set_team_member_role(v_member_mem, 'member');
  select role into v_role from amux.team_members
   where team_id = v_team and member_id = v_member_mem;
  if v_role is distinct from 'member' then
    raise exception 'admin should have been demoted to member, got %', v_role;
  end if;

  -- Cannot change own role.
  begin
    perform amux.set_team_member_role(v_admin_mem, 'member');
    raise exception 'expected self-role-change denial';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not ilike '%cannot change your own role%' then
        raise;
      end if;
  end;

  -- Cannot change the owner.
  begin
    perform amux.set_team_member_role(v_owner_mem, 'admin');
    raise exception 'expected owner-role-change denial';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not ilike '%cannot change the owner role%' then
        raise;
      end if;
  end;

  -- Owner can promote a member (idempotent admin→admin is fine).
  execute 'reset role';
  perform pg_temp.as_member(v_owner_uid);
  perform amux.set_team_member_role(v_member_mem, 'admin');
  perform amux.set_team_member_role(v_member_mem, 'admin');
  select role into v_role from amux.team_members
   where team_id = v_team and member_id = v_member_mem;
  if v_role is distinct from 'admin' then
    raise exception 'owner promote should leave role=admin, got %', v_role;
  end if;
end;
$$;

select plan(1);
select pass('set_team_member_role promotes and demotes under owner/admin rules');
select * from finish();
rollback;
