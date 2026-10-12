-- 20261008010000_agent_account_staff_grade.sql: a NEW agent account is written
-- at admin_type 2 when its inviter is staff of the team's org, else 1.
begin;

select plan(5);

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- A team in p_org with p_inviter as its member actor. Built directly: only the
-- claim is under test, and create_team allows one team per user.
create or replace function pg_temp.team_of(p_inviter uuid, p_org uuid, p_slug text)
returns uuid language plpgsql as $$
declare
  v_team uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
begin
  insert into amux.teams (id, name, slug, oid) values (v_team, p_slug, p_slug, p_org);
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values (v_member, v_team, 'member', p_inviter, 'Inviter');
  insert into amux.members (id, status) values (v_member, 'active');
  return v_team;
end;
$$;

-- Issue an agent invite from the team's member actor (optionally a rebind of
-- p_target), claim it anonymously as the daemon does, and return the
-- admin_type the agent's account carries afterwards.
create or replace function pg_temp.claimed_admin_type(p_team uuid, p_target uuid default null)
returns smallint language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_actor uuid;
  v_type smallint;
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
  select u.admin_type into v_type
    from amux.actors a join public.users u on u.id = a.user_id
   where a.id = v_actor;
  return v_type;
end;
$$;

insert into public.orgs (id, name) values
  ('77aa0000-0000-4000-8000-000000000001', 'Staff Grade Gym'),
  ('77aa0000-0000-4000-8000-000000000002', 'Staff Grade Shared');

-- staff:   employee of the gym on their own row.
-- member:  same org, admin_type 1 — a card, or a non-staff team member.
-- linked:  platform identity in the shared org, staff of the gym only through a
--          same-phone row (a real shape seen on belayo).
insert into auth.users (id, email, aud, role, instance_id) values
  ('77bb0000-0000-4000-8000-000000000001', 'staff@grade.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('77bb0000-0000-4000-8000-000000000002', 'member@grade.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('77bb0000-0000-4000-8000-000000000003', 'linked@grade.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('77bb0000-0000-4000-8000-000000000004', 'linked-staff@grade.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values
  ('77bb0000-0000-4000-8000-000000000001', '77bb0000-0000-4000-8000-000000000001', '77aa0000-0000-4000-8000-000000000001', '13800006661', 2),
  ('77bb0000-0000-4000-8000-000000000002', '77bb0000-0000-4000-8000-000000000002', '77aa0000-0000-4000-8000-000000000001', '13800006662', 1),
  ('77bb0000-0000-4000-8000-000000000003', '77bb0000-0000-4000-8000-000000000003', '77aa0000-0000-4000-8000-000000000002', '13800006663', 1),
  ('77bb0000-0000-4000-8000-000000000004', '77bb0000-0000-4000-8000-000000000004', '77aa0000-0000-4000-8000-000000000001', '13800006663', 2);

create temp table t as select
  pg_temp.team_of('77bb0000-0000-4000-8000-000000000001', '77aa0000-0000-4000-8000-000000000001', 'grade-staff') as staff_team,
  pg_temp.team_of('77bb0000-0000-4000-8000-000000000002', '77aa0000-0000-4000-8000-000000000001', 'grade-member') as member_team,
  pg_temp.team_of('77bb0000-0000-4000-8000-000000000003', '77aa0000-0000-4000-8000-000000000001', 'grade-linked') as linked_team,
  pg_temp.team_of('77bb0000-0000-4000-8000-000000000003', '77aa0000-0000-4000-8000-000000000002', 'grade-shared') as shared_team;
grant select on t to anon, authenticated;

select is(pg_temp.claimed_admin_type((select staff_team from t)), 2::smallint,
  'an agent invited by staff of the team''s org is staff-grade');
select is(pg_temp.claimed_admin_type((select member_team from t)), 1::smallint,
  'an agent invited by a non-staff member stays at 1');
select is(pg_temp.claimed_admin_type((select linked_team from t)), 2::smallint,
  'staff through a same-phone row counts');
select is(pg_temp.claimed_admin_type((select shared_team from t)), 1::smallint,
  'staff of ANOTHER org does not lift an agent of this one');

-- Rotation reuses the account and must not touch admin_type: give the member
-- team's agent an operator grant (as service_role, which is what a partner
-- deployment's guard requires), then rebind it.
update public.users set admin_type = 3
 where id = (select user_id from amux.actors
              where team_id = (select member_team from t) and actor_type = 'agent');
select is(
  pg_temp.claimed_admin_type((select member_team from t),
    (select id from amux.actors where team_id = (select member_team from t) and actor_type = 'agent')),
  3::smallint,
  'a rotated account keeps the admin_type an operator gave it'
);

select * from finish();
rollback;
