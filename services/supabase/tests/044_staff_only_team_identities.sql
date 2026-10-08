-- PHONE_LOGIN_STAFF_ONLY at team switch and in the picker
-- (20261008000000_staff_only_team_identities.sql).
--
-- The fixture is a real shape seen on belayo: one phone, three identities — a staff
-- record and a membership card in the same gym org, plus the platform identity
-- phone sign-up minted in the shared tenant. The card and the platform identity
-- each hold a team. The caller is signed in as the staff record.
begin;

select plan(9);

create temporary table staff_only_fixture (
  staff_id uuid not null,
  card_id uuid not null,
  shared_org uuid not null,
  card_team uuid not null,
  platform_team uuid not null
);
grant select on staff_only_fixture to anon, authenticated;

do $$
declare
  v_staff uuid := gen_random_uuid();
  v_card uuid := gen_random_uuid();
  v_platform uuid := gen_random_uuid();
  v_gym uuid := gen_random_uuid();
  v_shared uuid := gen_random_uuid();
  v_card_team uuid := gen_random_uuid();
  v_platform_team uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values
    (v_staff, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_card, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_platform, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_gym, 'Staff-only Gym'), (v_shared, 'Staff-only Shared');
  insert into public.users (id, auth_user_id, org_id, mobile, admin_type, deleted_at)
  values
    (v_staff, v_staff, v_gym, '13800007771', 2, null),
    (v_card, v_card, v_gym, '13800007771', 1, null),
    (v_platform, v_platform, v_shared, '13800007771', 1, null);
  insert into amux.teams (id, name, slug, oid, visibility)
  values
    (v_card_team, 'Card team', 'staff-only-card-team', v_gym, 'private'),
    (v_platform_team, 'Platform team', 'staff-only-platform-team', v_shared, 'private');
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values
    (gen_random_uuid(), v_card_team, 'member', v_card, 'Card'),
    (gen_random_uuid(), v_platform_team, 'member', v_platform, 'Platform');
  insert into staff_only_fixture values (v_staff, v_card, v_shared, v_card_team, v_platform_team);
end $$;

-- Impersonate the staff record.
select set_config('request.jwt.claims',
  json_build_object('sub', staff_id, 'role', 'authenticated')::text, true)
  from staff_only_fixture;
set local role authenticated;

-- Off: unchanged, every same-phone identity's team is reachable.
select ok(
  exists(select 1 from amux.list_teams_for_picker((select shared_org from staff_only_fixture), false)
          where team_slug = 'staff-only-card-team' and is_member),
  'flag off: the picker still lists a team only the card belongs to'
);
select ok(
  (select refresh_token is not null
     from amux.switch_active_team((select card_team from staff_only_fixture)) limit 1),
  'flag off: switching into the card''s team still mints a session'
);

-- On: the card is not an identity TeamClu acts as.
select ok(
  not exists(select 1 from amux.list_teams_for_picker((select shared_org from staff_only_fixture), false, true)
              where team_slug = 'staff-only-card-team'),
  'staff-only: the picker drops a team only the card belongs to'
);
select throws_ok(
  format('select * from amux.switch_active_team(%L, %L, true)',
         (select card_team from staff_only_fixture), (select shared_org from staff_only_fixture)),
  '42501',
  'not a member of this team',
  'staff-only: switching into the card''s team is refused'
);

-- The platform identity in the shared tenant still counts.
select ok(
  exists(select 1 from amux.list_teams_for_picker((select shared_org from staff_only_fixture), false, true)
          where team_slug = 'staff-only-platform-team' and is_member),
  'staff-only: the platform identity''s team stays listed'
);
select ok(
  (select refresh_token is not null
     from amux.switch_active_team((select platform_team from staff_only_fixture),
                                  (select shared_org from staff_only_fixture), true) limit 1),
  'staff-only: switching into the platform identity''s team still works'
);

-- A card session from before the switch loses its own teams too.
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', card_id, 'role', 'authenticated')::text, true)
  from staff_only_fixture;
set local role authenticated;

select throws_ok(
  format('select * from amux.switch_active_team(%L, %L, true)',
         (select card_team from staff_only_fixture), (select shared_org from staff_only_fixture)),
  '42501',
  'not a member of this team',
  'staff-only: a card session cannot switch into its own team'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker((select shared_org from staff_only_fixture), false, true)
              where team_slug = 'staff-only-card-team'),
  'staff-only: a card session does not see its own team'
);
reset role;

select ok(
  amux.is_teamclu_identity(gen_random_uuid(), null),
  'an account with no public.users row is not a card'
);

select * from finish();
rollback;
