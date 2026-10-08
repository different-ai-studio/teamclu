-- 20261008020000_member_invite_new_identity.sql: joining a team creates (or
-- reuses) the caller's identity in the team's org instead of moving them, and
-- under staff-only only staff of that org may invite.
begin;

select plan(22);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- An invite into p_team from its first member actor, claimed by p_caller;
-- returns the claim row as json (and leaves the session role reset).
create or replace function pg_temp.claim_as(p_caller uuid, p_team uuid)
returns jsonb language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_row jsonb;
begin
  insert into amux.team_invites (team_id, token, kind, team_role, display_name, invited_by_actor_id, expires_at)
  values (p_team, v_token, 'member', 'member', 'Joiner',
          (select id from amux.actors where team_id = p_team and actor_type = 'member' order by created_at limit 1),
          now() + interval '1 hour');
  perform pg_temp.as_user(p_caller);
  select to_jsonb(c) into v_row from amux.claim_team_invite(v_token) c;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v_row;
end;
$$;

create or replace function pg_temp.mk_team(p_owner uuid, p_org uuid, p_slug text)
returns uuid language plpgsql as $$
declare v_team uuid := gen_random_uuid(); v_m uuid := gen_random_uuid();
begin
  insert into amux.teams (id, name, slug, oid) values (v_team, p_slug, p_slug, p_org);
  insert into amux.actors (id, team_id, actor_type, user_id, display_name) values (v_m, v_team, 'member', p_owner, 'Owner');
  insert into amux.members (id, status) values (v_m, 'active');
  return v_team;
end;
$$;

create or replace function pg_temp.mk_user(p_id uuid, p_email text, p_org uuid, p_mobile text, p_admin smallint)
returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email, aud, role, instance_id)
  values (p_id, p_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
  if p_org is not null then
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type) values (p_id, p_id, p_org, p_mobile, p_admin);
  end if;
  return p_id;
end;
$$;

insert into public.orgs (id, name) values
  ('46aa0000-0000-4000-8000-000000000001', 'Co'),
  ('46aa0000-0000-4000-8000-000000000002', 'Phone own'),
  ('46aa0000-0000-4000-8000-000000000003', 'Mail own');

select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000001', 'boss@co.test',  '46aa0000-0000-4000-8000-000000000001', '', 3::smallint);
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000002', '13800004601@teamclu.mobile', '46aa0000-0000-4000-8000-000000000002', '13800004601', 3::smallint);
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000003', 'fresh@person.test', null, null, null);
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000004', 'Mail@Person.test', '46aa0000-0000-4000-8000-000000000003', '', 3::smallint);
-- Already a partner employee of Co, under the same phone as a tenant of their own.
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000005', 'emp@co.local', '46aa0000-0000-4000-8000-000000000001', '13800004605', 2::smallint);
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000006', '13800004605@teamclu.mobile', '46aa0000-0000-4000-8000-000000000002', '13800004605', 3::smallint);
-- A non-staff member of Co (a card that once joined a team).
select pg_temp.mk_user('46bb0000-0000-4000-8000-000000000007', 'card@co.test', '46aa0000-0000-4000-8000-000000000001', '', 1::smallint);

create temp table t as select
  pg_temp.mk_team('46bb0000-0000-4000-8000-000000000001', '46aa0000-0000-4000-8000-000000000001', 'co-team') as co_team,
  pg_temp.mk_team('46bb0000-0000-4000-8000-000000000002', '46aa0000-0000-4000-8000-000000000002', 'phone-own-team') as phone_team,
  pg_temp.mk_team('46bb0000-0000-4000-8000-000000000007', '46aa0000-0000-4000-8000-000000000001', 'card-team') as card_team;
grant select on t to anon, authenticated;

-- ── 1. A phone tenant joins Co: new identity, nobody moves ────────────────
create temp table c1 as select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000002', (select co_team from t)) as r;
create temp table id1 as
  select a.user_id from amux.actors a where a.id = ((select r from c1)->>'actor_id')::uuid;

select isnt((select user_id from id1), '46bb0000-0000-4000-8000-000000000002'::uuid, 'phone tenant joins as a NEW identity');
select is((select org_id from public.users where id = (select user_id from id1)), '46aa0000-0000-4000-8000-000000000001'::uuid, 'the new identity is in the team''s org');
select is((select admin_type from public.users where id = (select user_id from id1)), 2::smallint, 'the new identity is admin_type 2');
select is((select mobile::text from public.users where id = (select user_id from id1)), '13800004601', 'and carries the phone');
select is((select email::text from auth.users where id = (select user_id from id1)), (select user_id from id1)::text || '@teamclu.mobile', 'on a <id>@teamclu.mobile account');
select is((select org_id from public.users where id = '46bb0000-0000-4000-8000-000000000002'), '46aa0000-0000-4000-8000-000000000002'::uuid, 'the caller''s own identity did not move');
select is((select admin_type from public.users where id = '46bb0000-0000-4000-8000-000000000002'), 3::smallint, 'and keeps admin_type 3 in its own org');
select ok(exists(select 1 from amux.teams where id = (select phone_team from t)), 'the caller''s own team was not collected');
select ok(((select r from c1)->>'refresh_token') is not null, 'a session for the new identity is returned');

-- ── 2. A fresh account (no row) joins: becomes the identity itself ────────
create temp table c2 as select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000003', (select co_team from t)) as r;
select is((select a.user_id from amux.actors a where a.id = ((select r from c2)->>'actor_id')::uuid),
          '46bb0000-0000-4000-8000-000000000003'::uuid, 'a row-less account joins as itself');
select is((select admin_type from public.users where id = '46bb0000-0000-4000-8000-000000000003'), 2::smallint, 'at admin_type 2');
select is((select email::text from public.email_users_links where user_id = '46bb0000-0000-4000-8000-000000000003'), 'fresh@person.test', 'linked under its email');
select ok(((select r from c2)->>'refresh_token') is null, 'no extra session when the identity is the caller');

-- ── 3. An email tenant joins: synthetic account, linked both ways ─────────
create temp table c3 as select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000004', (select co_team from t)) as r;
create temp table id3 as
  select a.user_id from amux.actors a where a.id = ((select r from c3)->>'actor_id')::uuid;
select is((select email::text from auth.users where id = (select user_id from id3)), (select user_id from id3)::text || '@teamclu.email', 'email tenant joins on a <id>@teamclu.email account');
select is((select count(*)::int from public.email_users_links where email = 'mail@person.test'), 2, 'both identities linked under the lower-cased email');
select ok((select user_id from id3) in (select * from amux.person_identities('46bb0000-0000-4000-8000-000000000004')),
          'the person resolves to the new identity');

-- ── 4. Already staff of Co under the same phone: reuse ────────────────────
create temp table c4 as select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000006', (select co_team from t)) as r;
select is((select a.user_id from amux.actors a where a.id = ((select r from c4)->>'actor_id')::uuid),
          '46bb0000-0000-4000-8000-000000000005'::uuid, 'an existing staff identity in the org is reused');

-- ── 5. Joining twice through another identity ─────────────────────────────
select throws_ok(
  $$select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000002', (select co_team from t))$$,
  '23505', 'already a member of this team', 'the same person cannot join twice'
);

-- ── 6. Staff-only: only staff may invite ──────────────────────────────────
insert into amux.deployment_settings (key, value) values ('staff_only', 'true');
select throws_ok(
  $$select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000003', (select card_team from t))$$,
  '42501', 'invite was not issued by staff of this organization',
  'staff-only: an invite from a non-staff member does not admit'
);
select pg_temp.as_user('46bb0000-0000-4000-8000-000000000007');
select throws_ok(
  $$select * from amux.create_team_invite((select card_team from t), 'member', 'X', 'member')$$,
  '42501', 'only staff of this organization can invite members',
  'staff-only: a non-staff member cannot even create the invite'
);
reset role;
select pg_temp.as_user('46bb0000-0000-4000-8000-000000000001');
select lives_ok(
  $$select * from amux.create_team_invite((select co_team from t), 'member', 'X', 'member')$$,
  'staff-only: staff can'
);
reset role;
select lives_ok(
  $$select pg_temp.claim_as('46bb0000-0000-4000-8000-000000000003', (select phone_team from t))$$,
  'staff-only: an invite from staff of the team''s org admits'
);

select * from finish();
rollback;
