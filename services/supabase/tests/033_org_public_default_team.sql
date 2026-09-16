begin;

select plan(10);

-- bootstrap_login_team is the single login entry point. What it must do:
--   * a caller with a real org enters that org's PUBLIC default team, created
--     on first use and named after the org
--   * the SECOND caller in the same org JOINS that team instead of minting a
--     duplicate — the failure this whole redesign exists to stop
--   * a caller with no org mints one named after them, unless the deployment
--     turned self-registration off
--   * the shared partner tenant is an identity NAMESPACE, not the caller's
--     company: someone stamped with it who is not one of its EMPLOYEES gets an
--     org of their own, exactly like a caller with no org. Only its employees
--     join it. Building a private team inside it — the old behaviour — is how
--     unrelated people ended up sharing one tenant.

create temporary table login_bootstrap (
  what text not null,
  got text
);
grant select on login_bootstrap to anon, authenticated;

create or replace function pg_temp.act_as(p_uid uuid, p_org uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated',
    'app_metadata', case when p_org is null then '{}'::json
                         else json_build_object('org_id', p_org) end
  )::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$
declare
  v_org      uuid := gen_random_uuid();
  v_shared   uuid := gen_random_uuid();
  v_first    uuid := gen_random_uuid();
  v_second   uuid := gen_random_uuid();
  v_partner  uuid := gen_random_uuid();
  v_staff    uuid := gen_random_uuid();
  v_orphan   uuid := gen_random_uuid();
  v_team_a   uuid;
  v_team_b   uuid;
  v_role_b   text;
  v_team_p   uuid;
  v_team_s   uuid;
  v_team_o   uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id, raw_user_meta_data)
  values
    (v_first,   'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_second,  'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_partner, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_staff,   'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_orphan,  'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000',
     '{"full_name": "Orphan Otter"}'::jsonb);
  insert into public.orgs (id, name) values (v_org, 'Acme Ltd'), (v_shared, 'Shared Tenant');

  -- Employee-ness is amux.caller_employee_orgs(): a live public.users row with
  -- admin_type >= 2. v_partner is a retail sign-up stamped with the shared
  -- tenant; v_staff actually works there.
  insert into public.users (id, org_id, admin_type, mobile, email) values
    (v_partner, v_shared, 1, '', 'partner@amux.test'),
    (v_staff,   v_shared, 2, '', 'staff@amux.test');

  -- 1) first caller in a real org
  perform pg_temp.act_as(v_first, v_org);
  select team_id into v_team_a from amux.bootstrap_login_team(true, v_shared, 'First');
  execute 'reset role';
  insert into login_bootstrap values
    ('first_team_name', (select name from amux.teams where id = v_team_a)),
    ('first_team_visibility', (select visibility from amux.teams where id = v_team_a));

  -- 2) second caller, same org
  perform pg_temp.act_as(v_second, v_org);
  select team_id, role into v_team_b, v_role_b from amux.bootstrap_login_team(true, v_shared, 'Second');
  execute 'reset role';
  insert into login_bootstrap values
    ('second_team_same', case when v_team_b = v_team_a then 'same' else 'different' end),
    ('second_role', v_role_b),
    ('teams_in_org', (select count(*)::text from amux.teams where oid = v_org));

  -- 3) stamped with the shared tenant but NOT an employee of it: gets an org of
  --    its own rather than a team inside someone else's company.
  perform pg_temp.act_as(v_partner, v_shared);
  select team_id into v_team_p from amux.bootstrap_login_team(true, v_shared, 'Partner');
  execute 'reset role';
  insert into login_bootstrap values
    ('shared_nonstaff_org', case when (select oid from amux.teams where id = v_team_p) = v_shared
                                 then 'shared' else 'own' end),
    ('shared_nonstaff_visibility', (select visibility from amux.teams where id = v_team_p));

  -- 3b) an actual employee of the shared tenant still lands in it.
  perform pg_temp.act_as(v_staff, v_shared);
  select team_id into v_team_s from amux.bootstrap_login_team(true, v_shared, 'Staff');
  execute 'reset role';
  insert into login_bootstrap values
    ('shared_staff_org', case when (select oid from amux.teams where id = v_team_s) = v_shared
                              then 'shared' else 'own' end);

  -- 4) no org at all, self-registration allowed: mint an org named after them
  perform pg_temp.act_as(v_orphan, null);
  select team_id into v_team_o from amux.bootstrap_login_team(true, v_shared, 'ignored-for-org-name');
  execute 'reset role';
  insert into login_bootstrap values
    ('orphan_org_name', (select o.name from public.orgs o
                          join amux.teams t on t.oid = o.id where t.id = v_team_o)),
    ('orphan_team_name', (select name from amux.teams where id = v_team_o));
end $$;

select is((select got from login_bootstrap where what = 'first_team_name'), 'Acme Ltd',
  'the org default team is named after the org');
select is((select got from login_bootstrap where what = 'first_team_visibility'), 'public',
  'the org default team is public so the next member can find and join it');
select is((select got from login_bootstrap where what = 'second_team_same'), 'same',
  'the second member of an org JOINS the default team instead of minting a duplicate');
select is((select got from login_bootstrap where what = 'second_role'), 'member',
  'the joining member is not made an owner');
select is((select got from login_bootstrap where what = 'teams_in_org'), '1',
  'two people onboarding into one org produce exactly one team');
select is((select got from login_bootstrap where what = 'shared_nonstaff_org'), 'own',
  'a non-employee stamped with the shared tenant gets an org of their own');
select is((select got from login_bootstrap where what = 'shared_nonstaff_visibility'), 'public',
  'and takes the ordinary path from there — a public default team, not a private one');
select is((select got from login_bootstrap where what = 'shared_staff_org'), 'shared',
  'an employee of the shared tenant still lands in it');
select is((select got from login_bootstrap where what = 'orphan_org_name'), 'Orphan Otter',
  'an org-less caller gets an org named from their OAuth full name');
select is((select got from login_bootstrap where what = 'orphan_team_name'), 'Orphan Otter',
  'and the team is named after that org');

select * from finish();
rollback;
