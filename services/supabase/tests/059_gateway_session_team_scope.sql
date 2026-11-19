-- Gateway session RPCs act only on the caller's own team
-- (20261119130100_gateway_session_rpcs_team_scoped.sql).
--
-- They are SECURITY DEFINER, so RLS does not stop a caller from another team;
-- the functions have to. A stranger gets the same answer as for a row that does
-- not exist, and the team's own agent account keeps working.
begin;

select plan(20);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Team A: an owner member, and an agent whose daemon account (agent_uid) has
-- an actor in the team. Team B: the stranger.
insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0059-0000000000a1', 'gw-scope-owner@amux.test',    'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0059-0000000000a2', 'gw-scope-agent@amux.test',    'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0059-0000000000b1', 'gw-scope-stranger@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name) values
  ('00000000-0000-0000-0059-00000000000a', 'gw-scope-a', 'GW Scope A'),
  ('00000000-0000-0000-0059-00000000000b', 'gw-scope-b', 'GW Scope B');

insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
  ('00000000-0000-0000-0059-0000000001a1', '00000000-0000-0000-0059-00000000000a', 'member', 'Owner',    '00000000-0000-0000-0059-0000000000a1'),
  ('00000000-0000-0000-0059-0000000001a2', '00000000-0000-0000-0059-00000000000a', 'agent',  'Agent',    '00000000-0000-0000-0059-0000000000a2'),
  ('00000000-0000-0000-0059-0000000001b1', '00000000-0000-0000-0059-00000000000b', 'member', 'Stranger', '00000000-0000-0000-0059-0000000000b1');

insert into amux.members (id, status) values
  ('00000000-0000-0000-0059-0000000001a1', 'active'),
  ('00000000-0000-0000-0059-0000000001b1', 'active');

insert into amux.agents (id, owner_member_id, capabilities, status) values
  ('00000000-0000-0000-0059-0000000001a2', '00000000-0000-0000-0059-0000000001a1', '{}'::jsonb, 'active');

-- Two sessions of one chat in team A: the current one, and an older detached one.
insert into amux.sessions
  (id, team_id, created_by_actor_id, primary_agent_id, mode, title, binding, gateway_key, acp_session_id, source)
values
  ('00000000-0000-0000-0059-0000000005a1', '00000000-0000-0000-0059-00000000000a',
   '00000000-0000-0000-0059-0000000001a2', '00000000-0000-0000-0059-0000000001a2',
   'collab', 'WeCom - chat', 'wecom://chat-a', 'wecom://chat-a', 'acp-scope-current', 'gateway'),
  ('00000000-0000-0000-0059-0000000005a2', '00000000-0000-0000-0059-00000000000a',
   '00000000-0000-0000-0059-0000000001a2', '00000000-0000-0000-0059-0000000001a2',
   'collab', 'WeCom - chat (old)', null, 'wecom://chat-a', 'acp-scope-old', 'gateway');

-- ── A stranger from team B ───────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0059-0000000000b1');

select is(
  (select detached from amux.detach_gateway_session('acp-scope-current')),
  false,
  'stranger: detach of another team''s session reports not detached'
);
select is(
  (select session_id from amux.detach_gateway_session('acp-scope-current')),
  null,
  'stranger: detach does not reveal the session id'
);
select is(
  (select attached from amux.attach_gateway_session('wecom://chat-a', '00000000-0000-0000-0059-0000000005a2')),
  false,
  'stranger: attach to another team''s session reports not attached'
);
select is_empty(
  $$ select * from amux.list_gateway_sessions('00000000-0000-0000-0059-00000000000a', 'wecom://chat-a') $$,
  'stranger: listing another team''s gateway sessions returns nothing'
);
select throws_ok(
  $$ select * from amux.ensure_gateway_session(
       '00000000-0000-0000-0059-00000000000a', 'wecom://chat-x', 'x',
       '00000000-0000-0000-0059-0000000001a2', null, null) $$,
  '42501',
  'not a member of this team',
  'stranger: ensure in another team is refused'
);

reset role;
select results_eq(
  $$ select id, binding, title from amux.sessions
      where team_id = '00000000-0000-0000-0059-00000000000a' order by id $$,
  $$ values ('00000000-0000-0000-0059-0000000005a1'::uuid, 'wecom://chat-a'::text, 'WeCom - chat'::text),
            ('00000000-0000-0000-0059-0000000005a2'::uuid, null::text,             'WeCom - chat (old)'::text) $$,
  'stranger calls changed nothing in team A'
);
select is_empty(
  $$ select 1 from amux.sessions where binding = 'wecom://chat-x' $$,
  'stranger ensure created no session'
);

-- ── Team A's own agent account ───────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0059-0000000000a2');

select is(
  (select count(*)::int from amux.list_gateway_sessions('00000000-0000-0000-0059-00000000000a', 'wecom://chat-a')),
  2,
  'agent: lists its own team''s chat sessions'
);
select is(
  (select attached from amux.attach_gateway_session('wecom://chat-a', '00000000-0000-0000-0059-0000000005a2')),
  true,
  'agent: attaches its chat to an older session'
);
select is(
  (select detached from amux.detach_gateway_session('acp-scope-old')),
  true,
  'agent: detaches its own session'
);
select is(
  (select created from amux.ensure_gateway_session(
     '00000000-0000-0000-0059-00000000000a', 'wecom://chat-a', 'WeCom - chat',
     '00000000-0000-0000-0059-0000000001a2', null, null)),
  true,
  'agent: ensure opens a fresh session for its unbound chat'
);

-- ── No authenticated role: service_role and direct sessions are not checked ──
reset role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select is(
  (select count(*)::int from amux.list_gateway_sessions('00000000-0000-0000-0059-00000000000a', 'wecom://chat-a')),
  3,
  'service_role: list is not team-checked'
);
select set_config('request.jwt.claims', '', true);
select ok(amux.gateway_caller_in_team('00000000-0000-0000-0059-00000000000a'),
  'a direct database session is not team-checked');

select ok(
  not has_function_privilege('anon', 'amux.gateway_caller_in_team(uuid)', 'EXECUTE'),
  'anon cannot execute gateway_caller_in_team'
);

-- ── anon: no execute grant, and refused by the check even if it had one ──────
select ok(
  not has_function_privilege('anon', 'amux.detach_gateway_session(text)', 'EXECUTE'),
  'anon cannot execute detach_gateway_session'
);
select ok(
  not has_function_privilege('anon', 'amux.attach_gateway_session(text, uuid)', 'EXECUTE'),
  'anon cannot execute attach_gateway_session'
);
select ok(
  not has_function_privilege('anon', 'amux.list_gateway_sessions(uuid, text, integer)', 'EXECUTE'),
  'anon cannot execute list_gateway_sessions'
);
select ok(
  not has_function_privilege('anon', 'amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[])', 'EXECUTE'),
  'anon cannot execute ensure_gateway_session'
);
select ok(
  has_function_privilege('service_role', 'amux.detach_gateway_session(text)', 'EXECUTE'),
  'service_role can execute detach_gateway_session'
);
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select ok(not amux.gateway_caller_in_team('00000000-0000-0000-0059-00000000000a'),
  'an anon JWT is team-checked (and is not a member)');
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
