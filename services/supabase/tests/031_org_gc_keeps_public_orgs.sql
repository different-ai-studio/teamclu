-- 031_org_gc_keeps_public_orgs.sql
--
-- amux.claim_team_invite_legacy used to move a member onto the invite team's org
-- (strict single-org) and then collect the amux.teams of the org they left;
-- 20260817000000 had already narrowed that to our own tables (public.orgs is
-- saas-mono-owned). 20261008020000 retired the move altogether: the claimer
-- joins as their identity IN the team's org and nothing they had is touched.
--
-- Fixture shape kept from the GC days on purpose: alice is the SOLE user of her
-- org, the case where the old body deleted her teams.

begin;

select plan(5);

create or replace function pg_temp.as_user(p_user uuid, p_org uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_org is null then
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text
    else
      json_build_object('sub', p_user::text, 'role', 'authenticated',
                        'app_metadata', json_build_object('org_id', p_org::text))::text
    end,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Two orgs; alice alone in the old one, bob alone in the new one.
insert into public.orgs (id, name) values
  ('9c000000-0000-4000-8000-000000000001', 'GC Vacated Org'),
  ('9c000000-0000-4000-8000-000000000002', 'GC Destination Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('9c000000-0000-4000-8000-0000000000a1', 'alice-orggc@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('9c000000-0000-4000-8000-0000000000b1', 'bob-orggc@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

-- Keyed on `id`, not `auth_user_id`: claim_team_invite_legacy resolves the
-- claimer with `where id = auth.uid()`, so a row keyed the other way would leave
-- v_old_org null and skip the GC branch entirely.
insert into public.users (id, org_id, mobile) values
  ('9c000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-000000000001', ''),
  ('9c000000-0000-4000-8000-0000000000b1', '9c000000-0000-4000-8000-000000000002', '');

-- Alice's team under the org she is about to vacate.
insert into amux.teams (id, name, slug, oid) values
  ('9c000000-0000-4000-8000-0000000000e1', 'GC Vacated Team', 'gc-vacated-team',
   '9c000000-0000-4000-8000-000000000001');

-- Bob owns a team in the destination org and invites alice into it.
select pg_temp.as_user('9c000000-0000-4000-8000-0000000000b1',
                       '9c000000-0000-4000-8000-000000000002');
create temp table dest as
  select team_id from amux.create_team('GC Destination Team',
    p_oid => '9c000000-0000-4000-8000-000000000002');
grant select on dest to anon, authenticated;

create temp table inv as
  select * from amux.create_team_invite(
    (select team_id from dest), 'member', 'Alice', p_team_role => 'member');
grant select on inv to anon, authenticated;

-- ── Act: alice claims, vacating her org ─────────────────────────────────────
select pg_temp.as_user('9c000000-0000-4000-8000-0000000000a1',
                       '9c000000-0000-4000-8000-000000000001');
create temp table claimed as
  select * from amux.claim_team_invite((select token from inv));
grant select on claimed to anon, authenticated;

-- public.orgs and public.users are not readable as `authenticated` here; these
-- are observations about what the claim did, not RLS scenarios.
reset role;

-- ── Assert ──────────────────────────────────────────────────────────────────
select is((select actor_type from claimed), 'member',
          'alice claimed the member invite');

select is((select org_id from public.users
            where id = '9c000000-0000-4000-8000-0000000000a1'),
          '9c000000-0000-4000-8000-000000000001'::uuid,
          'the claimer is NOT moved: their identity stays in their org');

select is((select u.org_id from amux.actors a join public.users u on u.id = a.user_id
            where a.id = (select actor_id from claimed)),
          '9c000000-0000-4000-8000-000000000002'::uuid,
          'they joined as an identity in the invite team''s org');

select ok(exists (select 1 from public.orgs
                   where id = '9c000000-0000-4000-8000-000000000001'),
          'her org row survives — public.orgs is saas-mono-owned');

select is((select count(*) from amux.teams
            where oid = '9c000000-0000-4000-8000-000000000001'),
          1::bigint,
          'her team survives — nothing is collected any more');

select * from finish();
rollback;
