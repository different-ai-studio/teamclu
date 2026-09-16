-- 20260916120000_message_turn_trace.sql
--
-- A turn-final reply's `metadata.trace` pointer may be written by the agent
-- that sent the reply and by no one else, and writing it must leave every other
-- metadata key alone. amux.messages has no UPDATE policy, which is what made
-- the old full-column PATCH a silent no-op; these functions are the only way in.

begin;

select plan(14);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

insert into auth.users (id, email, aud, role, instance_id)
values
  ('00000000-0000-0000-0041-000000000001', 'trace-agent@teamclu.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0041-000000000002', 'trace-member@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0041-000000000003', 'trace-outside@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0041-000000000010', 'turn-trace', 'Turn Trace');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('00000000-0000-0000-0041-000000000020', '00000000-0000-0000-0041-000000000010', 'agent',  '00000000-0000-0000-0041-000000000001', 'Trace Agent'),
  ('00000000-0000-0000-0041-000000000030', '00000000-0000-0000-0041-000000000010', 'member', '00000000-0000-0000-0041-000000000002', 'Trace Member'),
  ('00000000-0000-0000-0041-000000000040', '00000000-0000-0000-0041-000000000010', 'member', '00000000-0000-0000-0041-000000000003', 'Outsider');

insert into amux.members (id, status)
values
  ('00000000-0000-0000-0041-000000000030', 'active'),
  ('00000000-0000-0000-0041-000000000040', 'active');

insert into amux.agents (id, owner_member_id, status)
values ('00000000-0000-0000-0041-000000000020', '00000000-0000-0000-0041-000000000030', 'active');

insert into amux.sessions (id, team_id, created_by_actor_id, primary_agent_id, mode, title)
values (
  '00000000-0000-0000-0041-000000000100',
  '00000000-0000-0000-0041-000000000010',
  '00000000-0000-0000-0041-000000000030',
  '00000000-0000-0000-0041-000000000020',
  'collab',
  'Traced session'
);

insert into amux.session_participants (session_id, actor_id)
values
  ('00000000-0000-0000-0041-000000000100', '00000000-0000-0000-0041-000000000020'),
  ('00000000-0000-0000-0041-000000000100', '00000000-0000-0000-0041-000000000030');

insert into amux.messages (id, team_id, session_id, sender_actor_id, kind, content, turn_id, metadata)
values (
  '00000000-0000-0000-0041-000000000200',
  '00000000-0000-0000-0041-000000000010',
  '00000000-0000-0000-0041-000000000100',
  '00000000-0000-0000-0041-000000000020',
  'agent_reply',
  'done',
  '00000000-0000-0000-0041-00000000a001',
  '{"sequence": 7, "turn_status": "ok"}'
);

select ok(
  has_function_privilege('authenticated', 'amux.record_turn_trace(uuid, uuid, text, uuid, jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'amux.record_turn_trace(uuid, uuid, text, uuid, jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'amux.authorize_turn_trace_upload(uuid, uuid, text, uuid)', 'EXECUTE'),
  'only authenticated callers can reach the trace functions'
);

-- ── The author ──────────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0041-000000000001');

select is(
  amux.authorize_turn_trace_upload(
    '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
    '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200'),
  null::jsonb,
  'the author is authorized and there is no trace yet'
);

select is(
  amux.record_turn_trace(
    '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
    '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200',
    '{"key": "turns/t/s/a.jsonl.gz", "size": 42, "sha256": "ab", "status": "uploaded"}') ->> 'status',
  'uploaded',
  'the author records an uploaded trace'
);

select is(
  amux.record_turn_trace(
    '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
    '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200',
    '{"key": "turns/t/s/a.jsonl.gz", "size": 42, "sha256": "ab", "status": "failed"}') ->> 'status',
  'uploaded',
  'a late failure report does not downgrade an uploaded trace'
);

select throws_ok(
  $$select amux.record_turn_trace(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200',
      '{"status": "done"}')$$,
  '22023', null,
  'a trace without a known status is rejected'
);

select throws_ok(
  $$select amux.record_turn_trace(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000ffff', '00000000-0000-0000-0041-000000000200',
      '{"status": "uploaded"}')$$,
  'P0002', null,
  'the turn id must match the message'
);

-- ── A participant who did not write the reply ───────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0041-000000000002');

select throws_ok(
  $$select amux.authorize_turn_trace_upload(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200')$$,
  '42501', null,
  'a participant cannot prepare an upload for the agent''s reply'
);

select throws_ok(
  $$select amux.record_turn_trace(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200',
      '{"key": "forged", "size": 1, "sha256": "00", "status": "uploaded"}')$$,
  '42501', null,
  'a participant cannot overwrite the agent''s trace'
);

select is_empty(
  $$update amux.messages set metadata = '{}'::jsonb
     where id = '00000000-0000-0000-0041-000000000200'
     returning id$$,
  'plain UPDATE still matches no row for a participant'
);

-- ── Someone outside the session ─────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0041-000000000003');

select throws_ok(
  $$select amux.authorize_turn_trace_upload(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200')$$,
  'P0002', null,
  'an outsider is told the message does not exist'
);

select throws_ok(
  $$select amux.record_turn_trace(
      '00000000-0000-0000-0041-000000000010', '00000000-0000-0000-0041-000000000100',
      '00000000-0000-0000-0041-00000000a001', '00000000-0000-0000-0041-000000000200',
      '{"status": "failed"}')$$,
  'P0002', null,
  'an outsider cannot record a trace either'
);

-- ── What the row ended up holding ───────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select metadata ->> 'turn_status' from amux.messages where id = '00000000-0000-0000-0041-000000000200'),
  'ok',
  'keys other than trace are untouched'
);

select is(
  (select (metadata ->> 'sequence')::int from amux.messages where id = '00000000-0000-0000-0041-000000000200'),
  7,
  'sequence survives the trace write'
);

select is(
  (select metadata -> 'trace' ->> 'key' from amux.messages where id = '00000000-0000-0000-0041-000000000200'),
  'turns/t/s/a.jsonl.gz',
  'the stored pointer is the author''s'
);

select * from finish();
rollback;
