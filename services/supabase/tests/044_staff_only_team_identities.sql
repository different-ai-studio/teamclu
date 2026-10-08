-- One person, one identity per org; TeamClu acts only as staff
-- (20261008000000_staff_only_team_identities.sql).
--
-- Fixture, a real shape seen on belayo: one phone with a staff record and a
-- membership card in a gym org, plus a tenant of their own (admin_type 3). The
-- card and the tenant identity each hold a team. Separately, an email user
-- whose second identity sits on a synthetic account, linked only through
-- public.email_users_links.
begin;

select plan(13);

create temporary table fx (
  staff_id uuid, card_id uuid, card_team uuid, tenant_team uuid,
  mail_id uuid, mail_second_id uuid, mail_team uuid
);
grant select on fx to anon, authenticated;

do $$
declare
  v_staff uuid := gen_random_uuid();
  v_card uuid := gen_random_uuid();
  v_tenant uuid := gen_random_uuid();
  v_mail uuid := gen_random_uuid();
  v_mail2 uuid := gen_random_uuid();
  v_gym uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_co uuid := gen_random_uuid();
  v_card_team uuid := gen_random_uuid();
  v_tenant_team uuid := gen_random_uuid();
  v_mail_team uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, created_at, updated_at, instance_id)
  values
    (v_staff, null, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_card, null, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_tenant, null, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_mail, 'Someone@Example.test', 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_mail2, v_mail2::text || '@teamclu.email', 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name)
  values (v_gym, 'Staff-only Gym'), (v_own, 'Staff-only Own'), (v_co, 'Staff-only Co');
  insert into public.users (id, auth_user_id, org_id, mobile, admin_type, deleted_at)
  values
    (v_staff, v_staff, v_gym, '13800007771', 2, null),
    (v_card, v_card, v_gym, '13800007771', 1, null),
    (v_tenant, v_tenant, v_own, '13800007771', 3, null),
    (v_mail, v_mail, v_own, '', 3, null),
    (v_mail2, v_mail2, v_co, '', 2, null);
  insert into public.email_users_links (email, user_id, org_id)
  values ('someone@example.test', v_mail, v_own), ('someone@example.test', v_mail2, v_co);
  insert into amux.teams (id, name, slug, oid, visibility)
  values
    (v_card_team, 'Card team', 'staff-only-card-team', v_gym, 'private'),
    (v_tenant_team, 'Tenant team', 'staff-only-tenant-team', v_own, 'private'),
    (v_mail_team, 'Mail co team', 'staff-only-mail-team', v_co, 'private');
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values
    (gen_random_uuid(), v_card_team, 'member', v_card, 'Card'),
    (gen_random_uuid(), v_tenant_team, 'member', v_tenant, 'Tenant'),
    (gen_random_uuid(), v_mail_team, 'member', v_mail2, 'Mail second');
  insert into fx values (v_staff, v_card, v_card_team, v_tenant_team, v_mail, v_mail2, v_mail_team);
end $$;

-- ── The phone user, signed in as the staff record ─────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', staff_id, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;

select ok(
  exists(select 1 from amux.list_teams_for_picker(null, false) where team_slug = 'staff-only-card-team' and is_member),
  'flag off: the picker still lists a team only the card belongs to'
);
select ok(
  (select refresh_token is not null from amux.switch_active_team((select card_team from fx)) limit 1),
  'flag off: switching into the card''s team still mints a session'
);
-- Turn the deployment setting on (operator action; client roles cannot).
reset role;
select throws_ok(
  $$set local role authenticated; insert into amux.deployment_settings values ('staff_only', 'true')$$,
  '42501', null, 'client roles cannot flip the staff-only setting'
);
reset role;
insert into amux.deployment_settings (key, value) values ('staff_only', 'true');
select set_config('request.jwt.claims',
  json_build_object('sub', staff_id, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;

select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, false) where team_slug = 'staff-only-card-team'),
  'staff-only: the picker drops a team only the card belongs to'
);
select throws_ok(
  format('select * from amux.switch_active_team(%L)', (select card_team from fx)),
  '42501', 'not a member of this team',
  'staff-only: switching into the card''s team is refused'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, false) where team_slug = 'staff-only-tenant-team' and is_member),
  'staff-only: the same phone''s tenant identity (3) keeps its team'
);
select ok(
  (select refresh_token is not null
     from amux.switch_active_team((select tenant_team from fx)) limit 1),
  'staff-only: switching into the tenant identity''s team works'
);

-- ── A card session from before the switch ─────────────────────────────────
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', card_id, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;

select throws_ok(
  format('select * from amux.switch_active_team(%L)', (select card_team from fx)),
  '42501', 'not a member of this team',
  'staff-only: a card session cannot switch into its own team'
);

-- ── The email user ─────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', mail_id, 'role', 'authenticated')::text, true) from fx;
set local role authenticated;

select ok(
  exists(select 1 from amux.list_teams_for_picker(null, false) where team_slug = 'staff-only-mail-team' and is_member),
  'an email user sees the team of their linked second identity'
);
create temp table sw as select * from amux.switch_active_team((select mail_team from fx));
reset role;
select is(
  (select a.user_id from amux.actors a where a.id = (select actor_id from sw)),
  (select mail_second_id from fx),
  'switching into it mints the second identity''s session'
);

select ok(
  (select mail_id from fx) in (select * from amux.person_identities((select mail_second_id from fx))),
  'the link is symmetric: the second identity resolves back to the first'
);
select ok(
  amux.is_teamclu_identity(gen_random_uuid()),
  'an account with no public.users row is not a card'
);
select ok(
  not exists (select 1 from information_schema.role_table_grants
               where table_schema = 'public' and table_name = 'email_users_links'
                 and grantee in ('anon', 'authenticated')),
  'email_users_links is not granted to client roles'
);

select * from finish();
rollback;
