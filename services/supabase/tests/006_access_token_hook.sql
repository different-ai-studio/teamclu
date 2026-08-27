begin;

select plan(30);

-- Rule catalog for a member yields exactly 10 allow rules with the expected topic shapes.
select is(
  (select count(*)::int
     from amux.amux_acl_rules_for(
       '11111111-1111-1111-1111-111111111111'::uuid,
       '22222222-2222-2222-2222-222222222222'::uuid,
       'member'
     )),
  10,
  'member rule set has exactly 10 rules'
);

select bag_eq(
  $$select action, topic from amux.amux_acl_rules_for(
      '11111111-1111-1111-1111-111111111111'::uuid,
      '22222222-2222-2222-2222-222222222222'::uuid,
      'member')$$,
  $$values
      ('sub','amux/11111111-1111-1111-1111-111111111111/user/22222222-2222-2222-2222-222222222222/notify'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/session/+/live'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/+/state'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/+/runtime/+/state'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/+/runtime/+/events'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/+/rpc/res'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/rpc/req'),
      ('sub','amux/11111111-1111-1111-1111-111111111111/sync/+'),
      ('pub','amux/11111111-1111-1111-1111-111111111111/+/rpc/req'),
      ('pub','amux/11111111-1111-1111-1111-111111111111/+/runtime/+/commands')
  $$,
  'member rule topics match exactly'
);

-- Unknown actor_type yields zero rows (no exception).
select is(
  (select count(*)::int
     from amux.amux_acl_rules_for(
       gen_random_uuid(), gen_random_uuid(), 'bogus'
     )),
  0,
  'unknown actor_type yields zero rules'
);

-- Rule catalog for an agent yields exactly 14 allow rules.
select is(
  (select count(*)::int
     from amux.amux_acl_rules_for(
       '33333333-3333-3333-3333-333333333333'::uuid,
       '44444444-4444-4444-4444-444444444444'::uuid,
       'agent'
     )),
  14,
  'agent rule set has exactly 14 rules'
);

select bag_eq(
  $$select action, topic from amux.amux_acl_rules_for(
      '33333333-3333-3333-3333-333333333333'::uuid,
      '44444444-4444-4444-4444-444444444444'::uuid,
      'agent')$$,
  $$values
      ('pub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/state'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/runtime/+/state'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/runtime/+/events'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/notify'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/+/rpc/res'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/+/rpc/req'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/session/+/live'),
      ('pub','amux/33333333-3333-3333-3333-333333333333/user/+/notify'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/runtime/+/commands'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/rpc/req'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444/notify'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/session/+/live'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/user/44444444-4444-4444-4444-444444444444/notify'),
      ('sub','amux/33333333-3333-3333-3333-333333333333/sync/+')
  $$,
  'agent rule topics match exactly'
);

-- Agents do not get the member-only "publish commands" permission.
select is(
  (select count(*)::int
     from amux.amux_acl_rules_for(
       gen_random_uuid(),
       gen_random_uuid(),
       'agent')
    where topic like '%runtime/+/commands' and action = 'pub'),
  0,
  'agent rule set does not include pub device/+/runtime/+/commands'
);

-- Hook called with null user_id (anon/service_role) must return event unchanged.
select is(
  amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', null,
      'claims',  jsonb_build_object('sub','anon','role','anon','aud','anon')
    )
  ),
  jsonb_build_object(
    'user_id', null,
    'claims',  jsonb_build_object('sub','anon','role','anon','aud','anon')
  ),
  'hook with null user_id returns event unchanged'
);

-- Single-team member: memberships has 1 row, acl has 10 team allow + 1 inbox + 1 deny.
do $$
declare
  v_team  uuid := gen_random_uuid();
  v_user  uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_out   jsonb;
  v_claims jsonb;
begin
  insert into auth.users (id) values (v_user);
  insert into amux.teams (id, slug, name) values (v_team, 'hook-solo', 'Hook Solo');
  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
    values (v_actor, v_team, 'member', 'solo-member', v_user);
  insert into amux.members (id, status) values (v_actor, 'active');
  insert into amux.team_members (team_id, member_id, role)
    values (v_team, v_actor, 'owner');

  v_out := amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', v_user,
      'claims',  jsonb_build_object(
        'sub',  v_user::text,
        'role', 'authenticated',
        'aud',  'authenticated',
        'iss',  'supabase'
      )
    )
  );
  v_claims := v_out->'claims';

  perform ok(
    v_claims ? 'acl',
    'single-team member: claims.acl present'
  );
  perform is(
    jsonb_array_length(v_claims->'acl'),
    12,
    'single-team member: acl has 10 team allow + 1 inbox + 1 deny = 12 rules'
  );
  perform is(
    v_claims->'acl'->10->>'topic',
    format('inbox/%s', v_user),
    'single-team member: inbox sub rule matches auth user_id'
  );
  perform is(
    jsonb_array_length(v_claims->'app_metadata'->'memberships'),
    1,
    'single-team member: memberships has 1 entry'
  );
  perform is(
    v_claims->'app_metadata'->'memberships'->0->>'team_id',
    v_team::text,
    'single-team member: membership team_id matches'
  );
  perform is(
    v_claims->'app_metadata'->'memberships'->0->>'actor_id',
    v_actor::text,
    'single-team member: membership actor_id matches'
  );
end;
$$;

-- User with zero actors: memberships empty, acl has inbox sub + deny-all.
do $$
declare
  v_user   uuid := gen_random_uuid();
  v_out    jsonb;
  v_claims jsonb;
begin
  insert into auth.users (id) values (v_user);

  v_out := amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', v_user,
      'claims',  jsonb_build_object(
        'sub',  v_user::text,
        'role', 'authenticated',
        'exp',  9999999999
      )
    )
  );
  v_claims := v_out->'claims';

  perform is(
    jsonb_array_length(v_claims->'app_metadata'->'memberships'),
    0,
    'zero-actor: memberships empty'
  );
  perform is(
    jsonb_array_length(v_claims->'acl'),
    2,
    'zero-actor: acl has inbox sub + deny-all'
  );
  perform is(
    v_claims->'acl'->0->>'topic',
    format('inbox/%s', v_user),
    'zero-actor: first rule is personal inbox sub'
  );
  perform is(
    v_claims->'acl'->1,
    jsonb_build_object('permission','deny','action','all','topic','#'),
    'zero-actor: last rule is deny-all'
  );
  perform is(
    (v_claims->>'exp')::bigint,
    9999999999::bigint,
    'zero-actor: upstream exp claim preserved'
  );
end;
$$;

-- Multi-team member: 2 memberships, 2*10+1 inbox+1 deny = 22 acl rules.
do $$
declare
  v_user   uuid := gen_random_uuid();
  v_team_a uuid := gen_random_uuid();
  v_team_b uuid := gen_random_uuid();
  v_act_a  uuid := gen_random_uuid();
  v_act_b  uuid := gen_random_uuid();
  v_out    jsonb;
  v_claims jsonb;
begin
  insert into auth.users (id) values (v_user);
  insert into amux.teams (id, slug, name) values
    (v_team_a, 'mt-a-' || left(v_team_a::text,8), 'MT A'),
    (v_team_b, 'mt-b-' || left(v_team_b::text,8), 'MT B');
  insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
    (v_act_a, v_team_a, 'member', 'A', v_user),
    (v_act_b, v_team_b, 'member', 'B', v_user);
  insert into amux.members (id, status) values
    (v_act_a, 'active'),
    (v_act_b, 'active');
  insert into amux.team_members (team_id, member_id, role) values
    (v_team_a, v_act_a, 'owner'),
    (v_team_b, v_act_b, 'owner');

  v_out := amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', v_user,
      'claims',  jsonb_build_object('sub', v_user::text, 'role', 'authenticated')
    )
  );
  v_claims := v_out->'claims';

  perform is(
    jsonb_array_length(v_claims->'app_metadata'->'memberships'),
    2,
    'multi-team member: 2 memberships'
  );
  perform is(
    jsonb_array_length(v_claims->'acl'),
    22,
    'multi-team member: 20 team allow + 1 inbox + 1 deny = 22 rules'
  );
  perform is(
    v_claims->'acl'->-1,
    jsonb_build_object('permission','deny','action','all','topic','#'),
    'multi-team member: last rule is deny-all'
  );
end;
$$;

-- Mixed actor types on one user: member in team A, agent in team B.
-- Expected: memberships has 2 entries, acl has 10 + 14 + 1 inbox + 1 deny = 26 rules.
do $$
declare
  v_user   uuid := gen_random_uuid();
  v_team_a uuid := gen_random_uuid();
  v_team_b uuid := gen_random_uuid();
  v_act_m  uuid := gen_random_uuid();
  v_act_a  uuid := gen_random_uuid();
  v_out    jsonb;
  v_claims jsonb;
begin
  insert into auth.users (id) values (v_user);
  insert into amux.teams (id, slug, name) values
    (v_team_a, 'mix-a-' || left(v_team_a::text,8), 'Mix A'),
    (v_team_b, 'mix-b-' || left(v_team_b::text,8), 'Mix B');
  insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
    (v_act_m, v_team_a, 'member', 'Member in A', v_user),
    ('10000000-0000-0000-0000-0000000000bb', v_team_b, 'member', 'Owner in B', null),
    (v_act_a, v_team_b, 'agent',  'Agent in B',  v_user);
  insert into amux.members (id, status) values (v_act_m, 'active');
  insert into amux.members (id, status) values ('10000000-0000-0000-0000-0000000000bb', 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team_a, v_act_m, 'owner');
  insert into amux.team_members (team_id, member_id, role) values (v_team_b, '10000000-0000-0000-0000-0000000000bb', 'owner');
  insert into amux.agents (id, owner_member_id, visibility, status) values (v_act_a, '10000000-0000-0000-0000-0000000000bb', 'team', 'active');

  v_out := amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', v_user,
      'claims',  jsonb_build_object('sub', v_user::text, 'role', 'authenticated')
    )
  );
  v_claims := v_out->'claims';

  perform is(
    jsonb_array_length(v_claims->'app_metadata'->'memberships'),
    2,
    'mixed: 2 memberships'
  );
  perform is(
    jsonb_array_length(v_claims->'acl'),
    26,
    'mixed: 10 (member) + 14 (agent) + 1 (inbox) + 1 (deny) = 26 rules'
  );
end;
$$;

-- Preservation of the caller's original claims (sub, aud, role, iss, exp, iat).
do $$
declare
  v_user   uuid := gen_random_uuid();
  v_out    jsonb;
  v_claims jsonb;
begin
  insert into auth.users (id) values (v_user);

  v_out := amux.amux_access_token_hook(
    jsonb_build_object(
      'user_id', v_user,
      'claims',  jsonb_build_object(
        'sub',  v_user::text,
        'aud',  'authenticated',
        'role', 'authenticated',
        'iss',  'https://srhaytajyfrniuvnkfpd.supabase.co/auth/v1',
        'exp',  1745003600,
        'iat',  1745000000,
        'jti',  'jti-xyz',
        'app_metadata', jsonb_build_object('provider','email')
      )
    )
  );
  v_claims := v_out->'claims';

  perform is(v_claims->>'sub',  v_user::text,                                         'preserve sub');
  perform is(v_claims->>'aud',  'authenticated',                                      'preserve aud');
  perform is(v_claims->>'role', 'authenticated',                                      'preserve role');
  perform is(v_claims->>'iss',  'https://srhaytajyfrniuvnkfpd.supabase.co/auth/v1',   'preserve iss');
  perform is(v_claims->'app_metadata'->>'provider', 'email',                          'preserve existing app_metadata keys');
end;
$$;

-- supabase_auth_admin must be able to execute both functions.
select ok(
  has_function_privilege(
    'supabase_auth_admin',
    'amux.amux_access_token_hook(jsonb)',
    'EXECUTE'
  ),
  'supabase_auth_admin can EXECUTE amux_access_token_hook'
);

select ok(
  has_function_privilege(
    'supabase_auth_admin',
    'amux.amux_acl_rules_for(uuid, uuid, text)',
    'EXECUTE'
  ),
  'supabase_auth_admin can EXECUTE amux_acl_rules_for'
);

select * from finish();
rollback;
