begin;

select plan(11);

select has_function(
  'amux',
  'list_current_actor_sessions_v2',
  array[
    'uuid',
    'text',
    'integer',
    'timestamp with time zone',
    'timestamp with time zone',
    'uuid',
    'uuid'
  ],
  'list_current_actor_sessions_v2 exists'
);

insert into public.orgs (id, name)
values ('01000000-0000-0000-0000-000000000099', 'Session list v2 org');

insert into auth.users (id, email)
values
  ('91000000-0000-0000-0000-000000000011', 'v2-reader@example.com'),
  ('91000000-0000-0000-0000-000000000012', 'v2-other@example.com');

insert into amux.teams (id, slug, name, oid)
values (
  '01000000-0000-0000-0000-000000000011',
  'session-list-v2',
  'Session List V2',
  '01000000-0000-0000-0000-000000000099'
);

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values
  ('11000000-0000-0000-0000-000000000011', '01000000-0000-0000-0000-000000000011', 'member', 'Reader', '91000000-0000-0000-0000-000000000011'),
  ('11000000-0000-0000-0000-000000000012', '01000000-0000-0000-0000-000000000011', 'member', 'Other',  '91000000-0000-0000-0000-000000000012');

insert into amux.members (id, status)
values
  ('11000000-0000-0000-0000-000000000011', 'active'),
  ('11000000-0000-0000-0000-000000000012', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values
  ('21000000-0000-0000-0000-000000000011', '01000000-0000-0000-0000-000000000011', '11000000-0000-0000-0000-000000000011', 'member'),
  ('21000000-0000-0000-0000-000000000012', '01000000-0000-0000-0000-000000000011', '11000000-0000-0000-0000-000000000012', 'member');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id)
values (
  '61000000-0000-0000-0000-000000000011',
  '01000000-0000-0000-0000-000000000011',
  '11000000-0000-0000-0000-000000000011',
  'List V2 App',
  'list-v2-app',
  'static_web',
  '01000000-0000-0000-0000-000000000099'
);

insert into amux.sessions (
  id, team_id, created_by_actor_id, mode, title,
  last_message_at, last_message_preview, created_at, source, app_id
)
values
  (
    '51000000-0000-0000-0000-000000000011',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'Regular A',
    '2026-11-02 10:00:00+00', 'a', '2026-11-02 09:59:00+00',
    'user', null
  ),
  (
    '51000000-0000-0000-0000-000000000012',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'Regular B',
    '2026-11-02 09:00:00+00', 'b', '2026-11-02 08:59:00+00',
    'user', null
  ),
  (
    '51000000-0000-0000-0000-000000000013',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'Gateway chat',
    '2026-11-02 11:00:00+00', 'gw', '2026-11-02 10:59:00+00',
    'gateway', null
  ),
  (
    '51000000-0000-0000-0000-000000000014',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'App session',
    '2026-11-02 08:00:00+00', 'app', '2026-11-02 07:59:00+00',
    'user', '61000000-0000-0000-0000-000000000011'
  ),
  (
    '51000000-0000-0000-0000-000000000015',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'Cron run',
    '2026-11-02 07:00:00+00', 'cron', '2026-11-02 06:59:00+00',
    'cron', null
  ),
  (
    '51000000-0000-0000-0000-000000000016',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab', 'Archived regular',
    '2026-11-02 12:00:00+00', 'arch', '2026-11-02 11:59:00+00',
    'user', null
  ),
  (
    '51000000-0000-0000-0000-000000000018',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000012',
    'collab', 'Other only',
    '2026-11-02 13:00:00+00', 'hidden', '2026-11-02 12:59:00+00',
    'user', null
  );

update amux.sessions
set archived_at = '2026-11-02 12:01:00+00'
where id = '51000000-0000-0000-0000-000000000016';

insert into amux.session_participants (session_id, actor_id, role)
values
  ('51000000-0000-0000-0000-000000000011', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000012', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000013', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000014', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000015', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000016', '11000000-0000-0000-0000-000000000011', 'member'),
  ('51000000-0000-0000-0000-000000000018', '11000000-0000-0000-0000-000000000012', 'member');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000011';

select is(
  (select count(*)::int from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'regular', 50
  )),
  2,
  'regular excludes gateway, app, cron, archived, and non-participant'
);

select is(
  (select count(*)::int from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'channel', 50
  )),
  1,
  'channel is source=gateway only'
);

select is(
  (select count(*)::int from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'app', 50
  )),
  1,
  'app is app_id set and not cron/gateway'
);

select is(
  (select count(*)::int from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'cron', 50
  )),
  1,
  'cron is source=cron only'
);

select is(
  (
    select array_agg(id order by last_message_at desc, created_at desc, id desc)
    from amux.list_current_actor_sessions_v2(
      '01000000-0000-0000-0000-000000000011', 'regular', 50
    )
  ),
  array[
    '51000000-0000-0000-0000-000000000011'::uuid,
    '51000000-0000-0000-0000-000000000012'::uuid
  ],
  'regular page is ordered newest-first'
);

select is(
  (
    select count(*)::int
    from amux.list_current_actor_sessions_v2(
      '01000000-0000-0000-0000-000000000011',
      'regular',
      1
    )
  ),
  1,
  'limit truncates the page'
);

select is(
  (
    with first_page as (
      select * from amux.list_current_actor_sessions_v2(
        '01000000-0000-0000-0000-000000000011', 'regular', 1
      )
    )
    select count(*)::int
    from amux.list_current_actor_sessions_v2(
      '01000000-0000-0000-0000-000000000011',
      'regular',
      50,
      (select last_message_at from first_page),
      (select created_at from first_page),
      (select id from first_page)
    )
  ),
  1,
  'keyset returns the remaining regular row without duplicating'
);

select throws_ok(
  $$select * from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'all', 50
  )$$,
  '22023',
  'list_current_actor_sessions_v2 p_kind must be regular, channel, app, or cron',
  'rejects legacy all kind'
);

select throws_ok(
  $$select * from amux.list_current_actor_sessions_v2(
    null, 'regular', 50
  )$$,
  '22023',
  'list_current_actor_sessions_v2 requires p_team_id',
  'requires team id'
);

-- Outsider: authenticated but not on this team
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000099';
select throws_ok(
  $$select * from amux.list_current_actor_sessions_v2(
    '01000000-0000-0000-0000-000000000011', 'regular', 50
  )$$,
  '42501',
  'list_current_actor_sessions_v2 requires team membership',
  'non-member is denied'
);

select * from finish();
rollback;
