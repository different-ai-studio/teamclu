-- 20261009010000_member_identity_public_email.sql: a member identity's
-- public.users row carries the person's email; phone users stay blank, and a
-- reused partner record is not touched.
begin;

select plan(7);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- An invite into p_team from its first member actor, claimed by p_caller;
-- returns the user id of the identity that joined.
create or replace function pg_temp.join_as(p_caller uuid, p_team uuid)
returns uuid language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_actor uuid;
begin
  insert into amux.team_invites (team_id, token, kind, team_role, display_name, invited_by_actor_id, expires_at)
  values (p_team, v_token, 'member', 'member', 'Joiner',
          (select id from amux.actors where team_id = p_team and actor_type = 'member' order by created_at limit 1),
          now() + interval '1 hour');
  perform pg_temp.as_user(p_caller);
  select actor_id into v_actor from amux.claim_team_invite(v_token);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return (select user_id from amux.actors where id = v_actor);
end;
$$;

create or replace function pg_temp.mk_user(p_id uuid, p_email text, p_org uuid, p_mobile text, p_admin smallint, p_row_email text default '')
returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email, aud, role, instance_id)
  values (p_id, p_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
  if p_org is not null then
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type, email)
    values (p_id, p_id, p_org, p_mobile, p_admin, p_row_email);
  end if;
  return p_id;
end;
$$;

create or replace function pg_temp.email_of(p_user uuid)
returns text language sql as $$ select email::text from public.users where id = p_user $$;

insert into public.orgs (id, name) values
  ('50aa0000-0000-4000-8000-000000000001', 'Co'),
  ('50aa0000-0000-4000-8000-000000000002', 'Phone own'),
  ('50aa0000-0000-4000-8000-000000000003', 'Mail own');

select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000001', 'boss@co.test', '50aa0000-0000-4000-8000-000000000001', '', 3::smallint);
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000002', '13800005002@teamclu.mobile', '50aa0000-0000-4000-8000-000000000002', '13800005002', 3::smallint);
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000003', 'Fresh@Person.test', null, null, null);
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000004', 'Mail@Person.test', '50aa0000-0000-4000-8000-000000000003', '', 3::smallint);
-- A partner employee record of Co with an email the partner set.
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000005', 'emp@person.test', '50aa0000-0000-4000-8000-000000000001', '', 2::smallint, 'partner-set@co.test');
-- Accounts with no row yet, for ensure_personal_org.
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000006', 'Founder@Example.test', null, null, null);
select pg_temp.mk_user('50bb0000-0000-4000-8000-000000000007', '13800005007@teamclu.mobile', null, null, null);

insert into amux.teams (id, name, slug, oid) values
  ('50cc0000-0000-4000-8000-000000000001', 'co-team', 'co-team-50', '50aa0000-0000-4000-8000-000000000001');
insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('50dd0000-0000-4000-8000-000000000001', '50cc0000-0000-4000-8000-000000000001', 'member', '50bb0000-0000-4000-8000-000000000001', 'Owner');
insert into amux.members (id, status) values ('50dd0000-0000-4000-8000-000000000001', 'active');

-- ── Joining by invite (ensure_member_identity) ───────────────────────────────
select is(pg_temp.email_of(pg_temp.join_as('50bb0000-0000-4000-8000-000000000003', '50cc0000-0000-4000-8000-000000000001')),
          'fresh@person.test', 'a row-less email account becomes an identity carrying its email');

create temp table j as select pg_temp.join_as('50bb0000-0000-4000-8000-000000000004', '50cc0000-0000-4000-8000-000000000001') as id;
select is(pg_temp.email_of((select id from j)), 'mail@person.test',
          'an email tenant''s new identity carries the person''s email');
select isnt((select email::text from auth.users where id = (select id from j)), 'mail@person.test',
            'not its synthetic login (which stays <id>@teamclu.email)');

select is(pg_temp.email_of(pg_temp.join_as('50bb0000-0000-4000-8000-000000000002', '50cc0000-0000-4000-8000-000000000001')),
          '', 'a phone user''s new identity keeps a blank email');

select is(pg_temp.email_of(pg_temp.join_as('50bb0000-0000-4000-8000-000000000005', '50cc0000-0000-4000-8000-000000000001')),
          'partner-set@co.test', 'a reused partner record keeps the email the partner set');

-- ── A tenant's creator (ensure_personal_org) ─────────────────────────────────
select pg_temp.as_user('50bb0000-0000-4000-8000-000000000006');
select amux.ensure_personal_org('Founder Co');
select pg_temp.as_user('50bb0000-0000-4000-8000-000000000007');
select amux.ensure_personal_org('Phone Co');
reset role;
select is(pg_temp.email_of('50bb0000-0000-4000-8000-000000000006'), 'founder@example.test',
          'an email creator''s row carries their email');
select is(pg_temp.email_of('50bb0000-0000-4000-8000-000000000007'), '',
          'a phone creator''s row keeps a blank email');

select * from finish();
rollback;
