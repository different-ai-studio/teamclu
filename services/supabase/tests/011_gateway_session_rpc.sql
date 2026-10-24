begin;

select plan(17);

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0011-000000000001', 'gw-session-team', 'Gateway Session Team');

insert into amux.actors (id, team_id, actor_type, display_name)
values
  ('00000000-0000-0000-0011-000000000010', '00000000-0000-0000-0011-000000000001', 'agent', 'Gateway Agent'),
  ('00000000-0000-0000-0011-000000000020', '00000000-0000-0000-0011-000000000001', 'member', 'Owner Member');

insert into amux.members (id, status)
values ('00000000-0000-0000-0011-000000000020', 'active');

-- agents.owner_member_id is NOT NULL and references members, so an owning
-- member has to exist first.
insert into amux.agents (id, owner_member_id, capabilities, status)
values ('00000000-0000-0000-0011-000000000010', '00000000-0000-0000-0011-000000000020', '{}'::jsonb, 'active');

insert into amux.actors (id, team_id, actor_type, source, source_id, display_name)
values ('00000000-0000-0000-0011-000000000030', '00000000-0000-0000-0011-000000000001', 'external', 'wecom', 'LiangLiang', 'LiangLiang');

select ok(
  not has_function_privilege('anon', 'amux.upsert_external_actor(uuid, text, text, text)', 'EXECUTE'),
  'anon cannot execute upsert_external_actor'
);

select ok(
  has_function_privilege('authenticated', 'amux.upsert_external_actor(uuid, text, text, text)', 'EXECUTE'),
  'authenticated can execute upsert_external_actor'
);

select ok(
  not has_function_privilege('anon', 'amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[])', 'EXECUTE'),
  'anon cannot execute ensure_gateway_session'
);

select ok(
  has_function_privilege('authenticated', 'amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[])', 'EXECUTE'),
  'authenticated can execute ensure_gateway_session'
);

select ok(
  has_function_privilege('service_role', 'amux.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[])', 'EXECUTE'),
  'service_role can execute ensure_gateway_session'
);

select lives_ok($$
  create temporary table gateway_session_result as
  select *
    from amux.ensure_gateway_session(
      '00000000-0000-0000-0011-000000000001',
      'wecom://aibot/aibfzYpdwyoj_3z9s4ZpVEFAv2IqAwVjNZH/single/LiangLiang',
      'WeCom - LiangLiang',
      '00000000-0000-0000-0011-000000000010',
      array['00000000-0000-0000-0011-000000000020']::uuid[],
      array['00000000-0000-0000-0011-000000000030']::uuid[]
    )
$$, 'ensure_gateway_session creates a gateway session without session_id ambiguity');

select is((select count(*) from gateway_session_result), 1::bigint, 'returns one row');
select ok((select session_id is not null from gateway_session_result), 'returns session_id');
select ok((select acp_session_id is not null from gateway_session_result), 'returns acp_session_id');
select is((select created from gateway_session_result), true, 'first call reports created');
select ok(
  (select cardinality(inserted_actor_ids) = 3
     and inserted_actor_ids @> array[
       '00000000-0000-0000-0011-000000000010',
       '00000000-0000-0000-0011-000000000020',
       '00000000-0000-0000-0011-000000000030'
     ]::uuid[]
     from gateway_session_result),
  'first call returns every inserted actor id'
);
select is(
  (select count(*) from amux.session_participants where session_id = (select session_id from gateway_session_result)),
  3::bigint,
  'snapshots agent, owner, and external participant'
);

create temporary table gateway_session_result_2 as
select *
  from amux.ensure_gateway_session(
    '00000000-0000-0000-0011-000000000001',
    'wecom://aibot/aibfzYpdwyoj_3z9s4ZpVEFAv2IqAwVjNZH/single/LiangLiang',
    'WeCom - LiangLiang',
    '00000000-0000-0000-0011-000000000010',
    array['00000000-0000-0000-0011-000000000020']::uuid[],
    array['00000000-0000-0000-0011-000000000030']::uuid[]
  );

select is((select created from gateway_session_result_2), false, 'second call reports existing session');
select is(
  (select cardinality(inserted_actor_ids) from gateway_session_result_2),
  0,
  'second call inserts no seats'
);
select is(
  (select session_id::text from gateway_session_result_2),
  (select session_id::text from gateway_session_result),
  'second call returns the same session'
);

insert into amux.actors (id, team_id, actor_type, display_name)
values ('00000000-0000-0000-0011-000000000040', '00000000-0000-0000-0011-000000000001', 'member', 'Late Member');

create temporary table gateway_session_result_3 as
select *
  from amux.ensure_gateway_session(
    '00000000-0000-0000-0011-000000000001',
    'wecom://aibot/aibfzYpdwyoj_3z9s4ZpVEFAv2IqAwVjNZH/single/LiangLiang',
    'WeCom - LiangLiang',
    '00000000-0000-0000-0011-000000000010',
    array['00000000-0000-0000-0011-000000000020']::uuid[],
    array[
      '00000000-0000-0000-0011-000000000030',
      '00000000-0000-0000-0011-000000000040'
    ]::uuid[]
  );

select is((select created from gateway_session_result_3), false, 'adding a seat does not recreate the session');
select is(
  (select inserted_actor_ids from gateway_session_result_3),
  array['00000000-0000-0000-0011-000000000040']::uuid[],
  'only the newly inserted actor id is returned'
);

select * from finish();
rollback;
