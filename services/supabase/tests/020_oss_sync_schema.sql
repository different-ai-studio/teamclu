begin;

select plan(50);

-- ---------------------------------------------------------------------------
-- Test helpers (copied from tests/007 for self-containment)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'anon')::text,
                     true);
  perform set_config('role', 'anon', true);
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

-- ---------------------------------------------------------------------------
-- Fixtures: alice (owner), bob (same team), cara (stranger)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role, instance_id) values
  ('a1111111-1111-1111-1111-111111111111', 'alice-oss@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('b2222222-2222-2222-2222-222222222222', 'bob-oss@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('c3333333-3333-3333-3333-333333333333', 'cara-oss@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select * from amux.create_team('OSS Team', p_oid => null);

create temp table ctx as
  select (select id from amux.teams where slug = 'oss-team') as team_id,
         'a1111111-1111-1111-1111-111111111111'::uuid           as alice,
         'b2222222-2222-2222-2222-222222222222'::uuid           as bob,
         'c3333333-3333-3333-3333-333333333333'::uuid           as cara;

-- Bob joins alice's team as a regular member. RLS on amux.actors only lets
-- a user insert their own row, so seed Bob as the table owner with RLS off.
-- Use raw role/RLS toggle (not as_service_role) because temp tables created
-- by the postgres login can't be read after `set role service_role`.
set local role postgres;
set local row_security = off;

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values ('b2222222-0000-0000-0000-000000000000',
          (select id from amux.teams where slug = 'oss-team'),
          'member', 'Bob',
          'b2222222-2222-2222-2222-222222222222');

insert into amux.members (id, status)
  values ('b2222222-0000-0000-0000-000000000000', 'active');

insert into amux.team_members (id, team_id, member_id, role)
  values ('b2222222-0000-0000-0000-000000000001',
          (select id from amux.teams where slug = 'oss-team'),
          'b2222222-0000-0000-0000-000000000000',
          'member');

-- Return to the default test identity (alice) for the assertions below.
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.1: team_workspace_config gains sync_mode / oss_change_seq / litellm_team_id
-- ---------------------------------------------------------------------------
select has_column('amux', 'team_workspace_config', 'sync_mode',
                  'team_workspace_config.sync_mode exists');
-- No default on purpose: share mode is a one-shot lock. A team that has never
-- called enable_team_share reads back sync_mode = null, which is what
-- GET /v1/teams/:id/share-mode reports as "team share not enabled". A default
-- of 'oss' would make every fresh team look like it had already chosen.
select col_hasnt_default('amux', 'team_workspace_config', 'sync_mode',
                  'sync_mode has no default: null until enable_team_share locks it');
select has_column('amux', 'team_workspace_config', 'oss_change_seq',
                  'team_workspace_config.oss_change_seq exists');
select has_column('amux', 'team_workspace_config', 'litellm_team_id',
                  'team_workspace_config.litellm_team_id exists');

-- Check constraint rejects unknown sync_mode values (run as postgres to bypass RLS).
-- The create_team RPC already seeded a row for this team, so delete it first
-- to exercise the INSERT path against the sync_mode check constraint.
set local role postgres;
set local row_security = off;
delete from amux.team_workspace_config where team_id = (select team_id from ctx);
prepare bad_sync_mode as
  insert into amux.team_workspace_config (team_id, sync_mode)
  values ((select team_id from ctx), 'lolwhat');
select throws_ok(
  'execute bad_sync_mode',
  '23514',  -- check_violation
  null,
  'sync_mode check constraint rejects unknown values');
deallocate bad_sync_mode;
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.2: amuxc_blobs
-- ---------------------------------------------------------------------------
select has_table('amux', 'amuxc_blobs', 'amuxc_blobs table exists');
select col_is_pk('amux', 'amuxc_blobs',
                 array['team_id', 'content_hash'],
                 'amuxc_blobs PK is (team_id, content_hash)');
select col_not_null('amux', 'amuxc_blobs', 'oss_key',
                    'amuxc_blobs.oss_key is NOT NULL');
select col_default_is('amux', 'amuxc_blobs', 'verified', 'false',
                      'amuxc_blobs.verified defaults to false');

-- Deleting the team cascades into amuxc_blobs.
set local role postgres;
set local row_security = off;
do $$
declare v_team uuid;
begin
  insert into amux.teams (slug, name) values ('blob-cascade', 'Blob Cascade')
    returning id into v_team;
  insert into amux.amuxc_blobs (team_id, content_hash, oss_key, size)
    values (v_team, 'deadbeef', 'teams/x/blobs/sha256/de/ad/beef', 42);
  delete from amux.teams where id = v_team;
end $$;
select is_empty(
  'select 1 from amux.amuxc_blobs where content_hash = ''deadbeef''',
  'amuxc_blobs cascades on team delete');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.3: amuxc_files — unique on (team_id, path) full (not partial), to
-- preserve the soft-delete-then-revive invariant.
-- ---------------------------------------------------------------------------
select has_table('amux', 'amuxc_files', 'amuxc_files table exists');
select col_default_is('amux', 'amuxc_files', 'deleted', 'false',
                      'amuxc_files.deleted defaults to false');
select col_default_is('amux', 'amuxc_files', 'current_version', '0',
                      'amuxc_files.current_version defaults to 0');

-- Unique (team_id, path) — not partial. Tombstone + revive must update the
-- existing row, never insert a second one.
--
-- `idx_amuxc_files_team_live_size` is the partial covering index behind the
-- per-team byte quota: `sum(size) where deleted = false` runs on the sync WRITE
-- path (once per prepare, once per prepare-batch, deliberately uncached), and
-- none of the other four indexes carries `deleted` or `size`.
select indexes_are('amux', 'amuxc_files',
  array['amuxc_files_pkey', 'uniq_amuxc_path',
        'idx_amuxc_files_team_updated', 'idx_amuxc_files_team_seq',
        'idx_amuxc_files_team_live_size'],
  'amuxc_files has expected indexes');

-- Same path can be inserted only once even when first row is deleted=true.
set local role postgres;
set local row_security = off;
create temp table _files_uniq_result (got_unique_violation boolean) on commit drop;
do $$
declare v_team uuid; v_actor uuid; v_file uuid; v_err text;
begin
  insert into amux.teams (slug, name) values ('files-uniq', 'Files Uniq')
    returning id into v_team;
  insert into amux.actors (team_id, actor_type, display_name, user_id)
    values (v_team, 'member', 'X', 'a1111111-1111-1111-1111-111111111111')
    returning id into v_actor;
  insert into amux.amuxc_files (team_id, path, deleted, updated_by)
    values (v_team, 'skills/x.md', true, v_actor) returning id into v_file;
  begin
    insert into amux.amuxc_files (team_id, path, deleted, updated_by)
      values (v_team, 'skills/x.md', false, v_actor);
    v_err := 'no-error';
  exception when unique_violation then
    v_err := 'unique_violation';
  end;
  insert into _files_uniq_result values (v_err = 'unique_violation');
  delete from amux.teams where id = v_team;
end $$;
select ok((select got_unique_violation from _files_uniq_result),
          'amuxc_files rejects duplicate (team_id, path) even when soft-deleted');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.4: amuxc_file_versions — immutable chain. (file_id, version) unique.
-- ---------------------------------------------------------------------------
select has_table('amux', 'amuxc_file_versions',
                 'amuxc_file_versions table exists');
select col_is_unique('amux', 'amuxc_file_versions',
                     array['file_id', 'version'],
                     'amuxc_file_versions has unique (file_id, version)');

-- Deleting an amuxc_files row cascades into its version chain.
set local role postgres;
set local row_security = off;
do $$
declare v_team uuid; v_actor uuid; v_file uuid;
begin
  insert into amux.teams (slug, name) values ('ver-cascade', 'Ver Cascade')
    returning id into v_team;
  insert into amux.actors (team_id, actor_type, display_name, user_id)
    values (v_team, 'member', 'X', 'a1111111-1111-1111-1111-111111111111')
    returning id into v_actor;
  insert into amux.amuxc_files (team_id, path, updated_by)
    values (v_team, 'skills/v.md', v_actor) returning id into v_file;
  insert into amux.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, created_by)
    values (v_file, 1, 0, 'abc', 10, v_actor);
  -- Delete amuxc_files first (cascades to amuxc_file_versions), then team.
  -- Direct team delete would hit restrict FK from amuxc_file_versions.created_by → actors.
  delete from amux.amuxc_files where id = v_file;
  delete from amux.teams where id = v_team;
end $$;
select is_empty(
  'select 1 from amux.amuxc_file_versions where content_hash = ''abc''',
  'amuxc_file_versions cascades when parent amuxc_files row is deleted');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.5: amuxc_upload_sessions
-- ---------------------------------------------------------------------------
select has_table('amux', 'amuxc_upload_sessions',
                 'amuxc_upload_sessions table exists');
select col_default_is('amux', 'amuxc_upload_sessions', 'status', 'pending',
                      'amuxc_upload_sessions.status defaults to pending');

-- Status check constraint rejects unknown values.
set local role postgres;
set local row_security = off;
prepare bad_status as
  insert into amux.amuxc_upload_sessions
    (team_id, actor_id, path, parent_version, content_hash, size,
     oss_key, status, expires_at)
  values ((select team_id from ctx),
          (select id from amux.actors where user_id = (select alice from ctx)
                                          and team_id = (select team_id from ctx)),
          'skills/x.md', 0, 'abc', 1,
          'teams/x/blobs/sha256/ab/c', 'lolwhat', now() + interval '1 hour');
select throws_ok(
  'execute bad_status',
  '23514',
  null,
  'amuxc_upload_sessions.status rejects unknown values');
deallocate bad_status;
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.7: guard trigger — authenticated callers cannot mutate the sync
-- waterline / sync_mode / litellm_team_id.
-- ---------------------------------------------------------------------------

-- Ensure a team_workspace_config row exists for the test team so the trigger
-- has something to fire on. The create_team RPC seeds one at team creation,
-- but the earlier sync_mode-check-constraint sub-test deletes it; re-insert
-- here to make this block robust to either path.
set local role postgres;
set local row_security = off;
insert into amux.team_workspace_config (team_id)
  values ((select team_id from ctx))
  on conflict do nothing;

-- Re-enable row_security before authenticated-role assertions (earlier blocks
-- used set local row_security = off; that persists until another set local).
set local row_security = on;

-- 7a. As alice (team owner, authenticated): updating sync_mode must fail.
select pg_temp.as_user((select alice from ctx));

-- Force a distinct value: post-flip the existing row defaults to 'oss',
-- so attempting to set it back to 'oss' would no-op and not fire the guard.
prepare alice_change_sync_mode as
  update amux.team_workspace_config
     set sync_mode = 'git'
   where team_id = (select team_id from ctx);
select throws_like(
  'execute alice_change_sync_mode',
  '%sync_mode%service-role only%',
  'authenticated cannot change sync_mode');
deallocate alice_change_sync_mode;

prepare alice_change_seq as
  update amux.team_workspace_config
     set oss_change_seq = 999
   where team_id = (select team_id from ctx);
select throws_like(
  'execute alice_change_seq',
  '%oss_change_seq%service-role only%',
  'authenticated cannot change oss_change_seq');
deallocate alice_change_seq;

prepare alice_change_litellm as
  update amux.team_workspace_config
     set litellm_team_id = 'pwned'
   where team_id = (select team_id from ctx);
select throws_like(
  'execute alice_change_litellm',
  '%litellm_team_id%service-role only%',
  'authenticated cannot change litellm_team_id');
deallocate alice_change_litellm;

-- 7b. Authenticated may still touch other columns (git_url is a non-guarded column).
select lives_ok(
  $$update amux.team_workspace_config
       set git_url = 'https://example.com/repo.git'
     where team_id = (select team_id from ctx)$$,
  'authenticated can still update non-guarded columns');

-- 7c. service_role may change guarded columns freely.
-- Use postgres role with RLS off to avoid ctx temp table permission issues,
-- and set the role GUC to service_role so the trigger sees 'service_role'.
set local role postgres;
set local row_security = off;
select set_config('role', 'service_role', true);
select lives_ok(
  $$update amux.team_workspace_config
       set sync_mode = 'oss', oss_change_seq = 1, litellm_team_id = 'svc'
     where team_id = (select id from amux.teams where slug = 'oss-team')$$,
  'service_role can update guarded columns');

-- restore alice for subsequent tests
set local row_security = on;
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111'::uuid);

-- ---------------------------------------------------------------------------
-- §2.7: RLS — team members SELECT, no client INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------

-- Insert a blob row as service_role so we have something to read.
set local role postgres;
set local row_security = off;
insert into amux.amuxc_blobs (team_id, content_hash, oss_key, size)
  values ((select team_id from ctx),
          'rls-fixture-hash',
          'teams/oss-team/blobs/sha256/rl/sf/ixture',
          7);

-- 8a. RLS is enabled on all four tables.
select is(
  (select bool_and(relrowsecurity) from pg_class
    where relname in ('amuxc_blobs','amuxc_files','amuxc_file_versions','amuxc_upload_sessions')),
  true,
  'RLS is enabled on all amuxc_* tables');

-- 8b. Alice (team member) can SELECT her team's blob.
-- Switch session role to authenticated so RLS policies fire.
-- Re-enable row_security (earlier blocks used set local row_security = off).
set local row_security = on;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a1111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  true);
select set_config('role', 'authenticated', true);
select isnt_empty(
  $$select 1 from amux.amuxc_blobs
     where content_hash = 'rls-fixture-hash'$$,
  'alice can SELECT her team blob');

-- 8c. Bob (same team) can SELECT.
select set_config('request.jwt.claims',
  json_build_object('sub', 'b2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  true);
select isnt_empty(
  $$select 1 from amux.amuxc_blobs
     where content_hash = 'rls-fixture-hash'$$,
  'bob can SELECT same-team blob');

-- 8d. Cara (stranger) cannot SELECT.
select set_config('request.jwt.claims',
  json_build_object('sub', 'c3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  true);
select is_empty(
  $$select 1 from amux.amuxc_blobs
     where content_hash = 'rls-fixture-hash'$$,
  'stranger cara cannot SELECT another team blob');

-- 8e. Anon cannot SELECT (no grant → permission denied).
set local role anon;
select set_config('request.jwt.claims',
  json_build_object('role', 'anon')::text,
  true);
select set_config('role', 'anon', true);
prepare anon_select_blob as
  select 1 from amux.amuxc_blobs where content_hash = 'rls-fixture-hash';
select throws_ok(
  'execute anon_select_blob',
  '42501',
  null,
  'anon cannot SELECT amuxc_blobs');
deallocate anon_select_blob;

-- 8f. Authenticated (alice) cannot INSERT.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a1111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  true);
select set_config('role', 'authenticated', true);
prepare alice_insert_blob as
  insert into amux.amuxc_blobs (team_id, content_hash, oss_key, size)
  values ((select id from amux.teams where slug = 'oss-team'), 'pwn', 'teams/x/blobs/sha256/pw/n/x', 1);
select throws_ok(
  'execute alice_insert_blob',
  '42501',
  null,
  'authenticated cannot INSERT into amuxc_blobs');
deallocate alice_insert_blob;

-- 8g. Authenticated (alice) cannot UPDATE.
prepare alice_update_blob as
  update amux.amuxc_blobs set verified = true
   where content_hash = 'rls-fixture-hash';
select throws_ok(
  'execute alice_update_blob',
  '42501',
  null,
  'authenticated cannot UPDATE amuxc_blobs');
deallocate alice_update_blob;

-- 8h. Authenticated (alice) cannot DELETE.
prepare alice_delete_blob as
  delete from amux.amuxc_blobs
   where content_hash = 'rls-fixture-hash';
select throws_ok(
  'execute alice_delete_blob',
  '42501',
  null,
  'authenticated cannot DELETE from amuxc_blobs');
deallocate alice_delete_blob;

-- ---------------------------------------------------------------------------
-- §8: actor_id_for_user_in_team helper
-- ---------------------------------------------------------------------------

-- 9a. alice in her own team → returns alice's actor id
set local role postgres;
set local row_security = off;
select is(
  amux.actor_id_for_user_in_team(
    (select alice from ctx),
    (select team_id from ctx)
  ),
  (select id from amux.actors
    where user_id = (select alice from ctx)
      and team_id = (select team_id from ctx)),
  'actor_id_for_user_in_team: alice in her team returns her actor id'
);

-- 9b. alice with cara's team (stranger) → returns null
-- cara's team doesn't exist in this fixture, so we use a random uuid.
select is(
  amux.actor_id_for_user_in_team(
    (select alice from ctx),
    gen_random_uuid()
  ),
  null::uuid,
  'actor_id_for_user_in_team: user not in team returns null'
);

-- 9c. authenticated role cannot call the function.
--
-- Asserted through the catalog rather than by calling it. On the Supabase
-- postgres image this suite runs against (17.6.1.106), a function call the
-- current role has no EXECUTE privilege for does not raise 42501 — it
-- segfaults the backend. Reproduces with core functions too
-- (`set role authenticated; select pg_read_file('/etc/hostname')`), so it is
-- the image's permission-denied path, not anything in this schema. The old
-- form of this test crashed the server here every run, and because psql's
-- exit code was ignored, run.sh reported the file as passing.
select ok(
  not has_function_privilege(
    'authenticated',
    'amux.actor_id_for_user_in_team(uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot call actor_id_for_user_in_team'
);

-- ---------------------------------------------------------------------------
-- §9: amuxc_complete_upload RPC (basic smoke — full CAS tested in FC integration)
-- ---------------------------------------------------------------------------
set local role postgres;
set local row_security = off;

-- The RPC requires a team_workspace_config row with sync_mode='oss'.
-- The row was inserted in the guard-trigger test above; update sync_mode now.
-- (service_role mock: use the GUC we already set in the trigger tests)
select set_config('role', 'service_role', true);

-- Insert a minimal upload session and call the RPC.
do $$
declare
  v_actor   uuid;
  v_session uuid;
begin
  v_actor := (select id from amux.actors
               where user_id = 'a1111111-1111-1111-1111-111111111111'::uuid
                 and team_id = (select id from amux.teams where slug = 'oss-team')
               limit 1);

  -- Ensure team_workspace_config has sync_mode='oss' and oss_change_seq=0
  update amux.team_workspace_config
     set sync_mode = 'oss', oss_change_seq = 0
   where team_id = (select id from amux.teams where slug = 'oss-team');

  -- Seed blob
  insert into amux.amuxc_blobs (team_id, content_hash, oss_key, size)
    values ((select id from amux.teams where slug = 'oss-team'),
            'rpc-test-hash', 'teams/x/blobs/sha256/rp/ct/esthash', 100)
  on conflict do nothing;

  -- Create upload session
  insert into amux.amuxc_upload_sessions
    (team_id, actor_id, path, parent_version, content_hash, size, oss_key, expires_at)
  values
    ((select id from amux.teams where slug = 'oss-team'),
     v_actor,
     'skills/rpc-test.md', 0,
     'rpc-test-hash', 100,
     'teams/x/blobs/sha256/rp/ct/esthash',
     now() + interval '1 hour')
  returning id into v_session;

  -- Call the RPC and verify it returns version=1, change_seq=1
  perform amux.amuxc_complete_upload(v_session, v_actor);
end $$;

select is(
  (select current_version from amux.amuxc_files
    where path = 'skills/rpc-test.md'
      and team_id = (select id from amux.teams where slug = 'oss-team')),
  1,
  'amuxc_complete_upload: file pointer advanced to version 1'
);

select is(
  (select oss_change_seq from amux.team_workspace_config
    where team_id = (select id from amux.teams where slug = 'oss-team')),
  1::bigint,
  'amuxc_complete_upload: oss_change_seq advanced to 1 (waterline invariant)'
);

select is(
  (select verified from amux.amuxc_blobs
    where content_hash = 'rpc-test-hash'
      and team_id = (select id from amux.teams where slug = 'oss-team')),
  true,
  'amuxc_complete_upload: blob.verified flipped to true'
);

-- CAS conflict: calling complete_upload again with parent_version=0 must raise P0409
prepare cas_conflict as
  select amux.amuxc_complete_upload(
    (select id from amux.amuxc_upload_sessions
      where path = 'skills/rpc-test.md'
        and status = 'completed' limit 1),
    (select id from amux.actors
      where user_id = 'a1111111-1111-1111-1111-111111111111'::uuid
        and team_id = (select id from amux.teams where slug = 'oss-team') limit 1)
  );
select throws_ok(
  'execute cas_conflict',
  null,
  null,
  'amuxc_complete_upload: re-completing a completed session raises an error'
);
deallocate cas_conflict;

-- amuxc_complete_delete: delete the file we just created and verify tombstone
do $$
declare
  v_actor uuid;
begin
  v_actor := (select id from amux.actors
               where user_id = 'a1111111-1111-1111-1111-111111111111'::uuid
                 and team_id = (select id from amux.teams where slug = 'oss-team')
               limit 1);
  -- current_version is 1 from the upload above, so parent_version=1
  perform amux.amuxc_complete_delete(
    (select id from amux.teams where slug = 'oss-team'),
    'skills/rpc-test.md',
    1,
    v_actor,
    null
  );
end $$;

select is(
  (select deleted from amux.amuxc_files
    where path = 'skills/rpc-test.md'
      and team_id = (select id from amux.teams where slug = 'oss-team')),
  true,
  'amuxc_complete_delete: file marked deleted'
);

-- ---------------------------------------------------------------------------
-- Tests 43-50: set_team_sync_mode + get_team_sync_mode (migration 20260527000004)
-- ---------------------------------------------------------------------------

-- Test 43: set_team_sync_mode rejects bad mode (22023)
select pg_temp.as_user((select alice from ctx));
select throws_ok(
  $$select amux.set_team_sync_mode((select team_id from ctx), 'invalid')$$,
  '22023',
  null,
  'set_team_sync_mode rejects unknown mode with 22023'
);

-- Test 44: set_team_sync_mode from non-member (cara) → 42501
select pg_temp.as_user((select cara from ctx));
select throws_ok(
  $$select amux.set_team_sync_mode((select team_id from ctx), 'oss')$$,
  '42501',
  null,
  'set_team_sync_mode blocks non-member with 42501'
);

-- Test 45: set_team_sync_mode from member-but-not-owner (bob) → 42501
select pg_temp.as_user((select bob from ctx));
select throws_ok(
  $$select amux.set_team_sync_mode((select team_id from ctx), 'oss')$$,
  '42501',
  null,
  'set_team_sync_mode blocks non-owner member with 42501'
);

-- Test 46: set_team_sync_mode from owner (alice) → returns 'oss', column updated
select pg_temp.as_user((select alice from ctx));
select is(
  amux.set_team_sync_mode((select team_id from ctx), 'oss'),
  'oss',
  'set_team_sync_mode owner switch to oss returns oss'
);
-- Read back via postgres role (avoids RLS × row_security=off interaction from earlier blocks).
set local role postgres;
set local row_security = on;
select is(
  (select sync_mode from amux.team_workspace_config where team_id = (select team_id from ctx)),
  'oss',
  'set_team_sync_mode: column is updated in DB after owner switch to oss'
);
set local row_security = off;
select pg_temp.as_user((select alice from ctx));

-- Test 47: owner can flip back to git
select is(
  amux.set_team_sync_mode((select team_id from ctx), 'git'),
  'git',
  'set_team_sync_mode owner switch back to git returns git'
);

-- Test 48: get_team_sync_mode returns current value for member
select pg_temp.as_user((select bob from ctx));
-- Read via postgres role for the same reason.
set local role postgres;
set local row_security = on;
select is(
  amux.get_team_sync_mode((select team_id from ctx)),
  'git',
  'get_team_sync_mode returns current sync_mode for authenticated member'
);
set local row_security = off;

-- Test 49: direct authenticated UPDATE on sync_mode still blocked by guard trigger.
-- We use a postgres-role DO block (bypassing RLS) to set the role to 'authenticated'
-- and verify the trigger fires. We can't use throws_ok at the top level because
-- RLS errors surface differently; instead we catch the exception in a DO block.
do $$
declare v_caught_code text := 'no-error';
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('app.allow_sync_mode_switch', 'off', true);
  begin
    update amux.team_workspace_config
       set sync_mode = 'oss'
     where team_id = (select team_id from ctx);
  exception
    when sqlstate '42501' then
      v_caught_code := '42501';
    when others then
      v_caught_code := sqlstate;
  end;
  -- Reset to postgres role for remaining assertions
  perform set_config('role', 'postgres', true);
  if v_caught_code <> '42501' then
    raise exception 'expected 42501 from guard trigger but got %', v_caught_code;
  end if;
end $$;

select pass('direct authenticated UPDATE on sync_mode still blocked by guard trigger');

-- Reset to alice context for safety.
set local role postgres;
select pg_temp.as_user((select alice from ctx));

select * from finish();
rollback;
