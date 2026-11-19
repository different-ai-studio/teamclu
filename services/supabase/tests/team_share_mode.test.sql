-- team_share_mode.test.sql
--
-- What is left of team share mode. The switch RPCs (enable_team_share /
-- disable_team_share) were dropped in 20261119000000 — nothing called them —
-- but the teams.share_mode column and its enum stay (an in-use enum value
-- cannot be dropped; dropping the column is a one-way door). This pins that:
--   1. teams.share_mode still exists with its enum type.
--   2. A fresh team has share_mode NULL and team_workspace_config.sync_mode
--      NULL (create_team seeds neither).
--   3. The switch RPCs are gone.
--   4. Direct UPDATEs of the column are not blocked by a guard trigger.
--
-- Run via:
--   ./run.sh team_share_mode.test.sql

begin;

select plan(9);

-- Helpers (mirror 007_team_workspace_config.sql)
create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_service_role()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'service_role')::text,
                     true);
  perform set_config('role', 'service_role', true);
end;
$$;

-- Fixture: one authenticated user, one team via amux.create_team
insert into auth.users (id, email, aud, role, instance_id) values
  ('aa111111-1111-1111-1111-111111111111', 'alice-share@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bb222222-2222-2222-2222-222222222222', 'bob-share@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('aa111111-1111-1111-1111-111111111111');
select * from amux.create_team('Share Team', p_oid => null);

-- 1. teams.share_mode column exists with the expected enum type
select has_column('amux', 'teams', 'share_mode', 'teams.share_mode column exists');
select col_type_is('amux', 'teams', 'share_mode', 'amux.team_share_mode', 'share_mode is amux.team_share_mode');

-- 2. Fresh team: share_mode IS NULL
select is(
  (select share_mode from amux.teams where slug = 'share-team'),
  null::amux.team_share_mode,
  'fresh team has null share_mode'
);

-- 3. Fresh team: team_workspace_config.sync_mode IS NULL
select is(
  (select twc.sync_mode
     from amux.team_workspace_config twc
     join amux.teams t on t.id = twc.team_id
    where t.slug = 'share-team'),
  null::text,
  'fresh team_workspace_config has null sync_mode'
);

-- 5. The switch RPCs are gone.
select hasnt_function('amux', 'enable_team_share',  'enable_team_share dropped');
select hasnt_function('amux', 'disable_team_share', 'disable_team_share dropped');

-- 6. Direct UPDATE of share_mode is allowed (no guard trigger).
select pg_temp.as_service_role();
select lives_ok(
  $q$ update amux.teams set share_mode = 'oss'::amux.team_share_mode
       where slug = 'share-team' $q$,
  'direct UPDATE of share_mode is allowed'
);

select is(
  (select share_mode::text from amux.teams where slug = 'share-team'),
  'oss',
  'teams.share_mode updated by a direct UPDATE'
);

-- 7. UPDATE that leaves share_mode unchanged still works (regression guard).
select lives_ok(
  $q$ update amux.teams set name = 'Share Team Renamed'
       where slug = 'share-team' $q$,
  'UPDATE that leaves share_mode unchanged is allowed'
);

select * from finish();
rollback;
