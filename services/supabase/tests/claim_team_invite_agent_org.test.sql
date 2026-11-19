-- claim_team_invite_agent_org.test.sql
--
-- pgTAP tests for daemon org_id stamping on claim (20260611000000 public,
-- 20260618000000 amux — FC calls amux.claim_team_invite):
--   1. Agent claim on an org-stamped team mints a daemon auth user whose
--      raw_app_meta_data carries org_id = teams.oid (new-agent path).
--   2. With that claim in the JWT (as GoTrue would embed it), the daemon user
--      passes teams_org_guard and can SELECT the team row (e.g. share_mode).
--   3. Without the claim, the same daemon user is blocked (regression control
--      — this was the bug: Sync Now → team_share_not_enabled_for_daemon).
--   4. Rebind path (target_actor_id) rotates to a new daemon user that also
--      carries the org claim.
--   5. Agent claim on a team without oid keeps raw_app_meta_data empty.
--
-- Run via (against a database with the migrations applied; see
-- services/supabase/migrations/README.md):
--   services/supabase/tests/run.sh claim_team_invite_agent_org.test.sql

begin;

select plan(10);

-- Helpers: simulate an authenticated JWT, optionally with app_metadata.org_id
-- (mirrors how GoTrue embeds raw_app_meta_data into minted access tokens).
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

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Fixture: an org, alice (team owner), and an org-stamped team.
insert into public.orgs (id, name)
values ('99aa0000-0000-4000-8000-000000000001', 'Org Guard Test Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('aa110000-0000-4000-8000-000000000001', 'alice-agentorg@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');
select * from amux.create_team('Agent Org Team', p_oid => '99aa0000-0000-4000-8000-000000000001');

-- Each fixture table is granted to both impersonated roles right where it is
-- created. The file hops between alice, anon and the daemon users, and a temp
-- table belongs to whichever role created it -- so without the grants the very
-- next hop reads it and gets "permission denied for table …".
create temp table ctx as
  select
    (select id from amux.teams where slug = 'agent-org-team') as team,
    '99aa0000-0000-4000-8000-000000000001'::uuid as org;
grant select on ctx to anon, authenticated;

select isnt((select team from ctx), null, 'fixture team created');
select is((select oid from amux.teams where id = (select team from ctx)),
          (select org from ctx),
          'fixture team is org-stamped (oid set)');

-- ── 1. New-agent claim stamps org_id into the daemon user's app_metadata ────
create temp table ai as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon One', p_agent_kind => 'daemon');
grant select on ai to anon, authenticated;

select pg_temp.as_anon();
create temp table ac as select * from amux.claim_team_invite((select token from ai));
grant select on ac to anon, authenticated;

-- Resolve the daemon's auth user as the session role: actors is RLS-guarded
-- and the claim above left us on anon, which would select zero rows and make
-- every assertion below compare against NULL.
reset role;
create temp table daemon1 as
  select a.user_id from amux.actors a where a.id = (select actor_id from ac);
grant select on daemon1 to anon, authenticated;

select ok((select refresh_token is not null from ac),
          'agent claim returns a refresh_token');
-- auth.users is not readable by anon; these are observations about what the
-- claim minted, not RLS scenarios, so make them as the session role.
reset role;
select is((select u.raw_app_meta_data ->> 'org_id' from auth.users u
            where u.id = (select user_id from daemon1)),
          (select org from ctx)::text,
          'new daemon user carries app_metadata.org_id = teams.oid');

-- ── 2. With the org claim, the daemon passes teams_org_guard ────────────────
select pg_temp.as_user((select user_id from daemon1), (select org from ctx));
select ok(exists (select 1 from amux.teams where id = (select team from ctx)),
          'daemon JWT with org claim can SELECT the team row (share-mode readable)');

-- ── 3. Without the claim, the daemon falls back to public.users ─────────────
-- This used to assert the opposite. claim_team_invite now also writes a
-- public.users row for the daemon account carrying the team's org, precisely so
-- that org resolvers which read public.users directly (rather than the JWT
-- claim) still resolve an org. A daemon JWT with no app_metadata.org_id
-- therefore passes teams_org_guard through that fallback.
select pg_temp.as_user((select user_id from daemon1));
select ok(exists (select 1 from amux.teams where id = (select team from ctx)),
          'daemon JWT without org claim resolves its org from the public.users fallback');

-- ── 4. Rebind (target_actor_id) keeps the account, refreshes the claim ──────
-- This used to assert the opposite: the agent branch minted a new auth user on
-- every rotation and deleted the old one. 20260819000000 stopped that — a
-- rotation replaces the credential, and everything keyed on the daemon's user
-- id (public.users.admin_type, user_metadata, grants) has to survive it. The
-- org stamp is refreshed on the account rather than baked into a new one, which
-- is what the following assertion now covers.
select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');
create temp table ri as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon One', p_agent_kind => 'daemon',
    p_target_actor_id => (select actor_id from ac));
grant select on ri to anon, authenticated;

select pg_temp.as_anon();
create temp table rc as select * from amux.claim_team_invite((select token from ri));
grant select on rc to anon, authenticated;

-- Resolve the daemon's auth user as the session role: actors is RLS-guarded
-- and the claim above left us on anon, which would select zero rows and make
-- every assertion below compare against NULL.
reset role;
create temp table daemon2 as
  select a.user_id from amux.actors a where a.id = (select actor_id from rc);
grant select on daemon2 to anon, authenticated;

select is((select user_id from daemon2), (select user_id from daemon1),
          'rebind leaves the actor on the daemon auth user it already had');
-- auth.users is not readable by anon; these are observations about what the
-- claim minted, not RLS scenarios, so make them as the session role.
reset role;
select is((select u.raw_app_meta_data ->> 'org_id' from auth.users u
            where u.id = (select user_id from daemon2)),
          (select org from ctx)::text,
          'rebound daemon user also carries app_metadata.org_id');

-- ── 5. Team without oid: daemon user gets no org claim, still sees the team ─
-- Clear the org stamp as the session role. teams has no policy that lets a
-- member null out oid, so as alice this UPDATE matched no row, the team kept
-- its org, and the assertion below was reading a team that was never changed.
reset role;
update amux.teams set oid = null where id = (select team from ctx);
select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');

create temp table ni as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon Two', p_agent_kind => 'daemon');
grant select on ni to anon, authenticated;

select pg_temp.as_anon();
create temp table nc as select * from amux.claim_team_invite((select token from ni));
grant select on nc to anon, authenticated;

-- auth.users is not readable by anon; these are observations about what the
-- claim minted, not RLS scenarios, so make them as the session role.
reset role;
select is((select u.raw_app_meta_data from auth.users u
            where u.id = (select a.user_id from amux.actors a
                           where a.id = (select actor_id from nc))),
          '{}'::jsonb,
          'team without oid mints daemon user with empty app_metadata');
select pg_temp.as_user(
  (select a.user_id from amux.actors a where a.id = (select actor_id from nc)));
select ok(exists (select 1 from amux.teams where id = (select team from ctx)),
          'oid-less team stays visible to claim-less daemon (guard tolerates null oid)');

select * from finish();
rollback;
