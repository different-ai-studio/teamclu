begin;

select plan(8);

select has_column('amux', 'sessions', 'list_kind', 'sessions.list_kind exists');

select has_function(
  'amux',
  'list_current_actor_sessions',
  array['uuid', 'integer', 'timestamp with time zone', 'timestamp with time zone', 'uuid', 'uuid', 'text']
);

insert into auth.users (id, email)
values ('91000000-0000-0000-0000-000000000011', 'list-kind@example.com');

insert into amux.teams (id, slug, name)
values ('01000000-0000-0000-0000-000000000011', 'list-kind-team', 'List Kind Team');

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values (
  '11000000-0000-0000-0000-000000000011',
  '01000000-0000-0000-0000-000000000011',
  'member',
  'Reader',
  '91000000-0000-0000-0000-000000000011'
);

insert into amux.members (id, status)
values ('11000000-0000-0000-0000-000000000011', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values (
  '21000000-0000-0000-0000-000000000011',
  '01000000-0000-0000-0000-000000000011',
  '11000000-0000-0000-0000-000000000011',
  'member'
);

insert into public.orgs (id, name)
values ('00000000-0000-0000-0011-000000000001', 'List kind org');

insert into amux.apps (id, team_id, created_by_actor_id, name, slug, type, org_id)
values (
  '61000000-0000-0000-0000-000000000011',
  '01000000-0000-0000-0000-000000000011',
  '11000000-0000-0000-0000-000000000011',
  '报销助手',
  'list-kind-app',
  'static_web',
  '00000000-0000-0000-0011-000000000001'
);

insert into amux.sessions (
  id, team_id, created_by_actor_id, mode, title, source, app_id, last_message_at, created_at
)
values
  (
    '51000000-0000-0000-0000-000000000011',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab',
    'User session',
    'user',
    null,
    '2026-10-29 10:00:00+00',
    '2026-10-29 09:00:00+00'
  ),
  (
    '51000000-0000-0000-0000-000000000012',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab',
    'Gateway session',
    'gateway',
    null,
    '2026-10-29 09:30:00+00',
    '2026-10-29 09:00:00+00'
  ),
  (
    '51000000-0000-0000-0000-000000000013',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab',
    'App session',
    'user',
    '61000000-0000-0000-0000-000000000011',
    '2026-10-29 09:00:00+00',
    '2026-10-29 09:00:00+00'
  ),
  (
    '51000000-0000-0000-0000-000000000014',
    '01000000-0000-0000-0000-000000000011',
    '11000000-0000-0000-0000-000000000011',
    'collab',
    'Cron session',
    'cron',
    null,
    '2026-10-29 08:30:00+00',
    '2026-10-29 08:00:00+00'
  );

insert into amux.session_participants (session_id, actor_id)
select id, '11000000-0000-0000-0000-000000000011'
from amux.sessions
where team_id = '01000000-0000-0000-0000-000000000011';

select is(
  (select list_kind from amux.sessions where id = '51000000-0000-0000-0000-000000000011'),
  'user',
  'plain session list_kind is user'
);

select is(
  (select list_kind from amux.sessions where id = '51000000-0000-0000-0000-000000000012'),
  'gateway',
  'gateway source list_kind is gateway'
);

select is(
  (select list_kind from amux.sessions where id = '51000000-0000-0000-0000-000000000013'),
  'app',
  'app_id wins over source=user'
);

select is(
  (select list_kind from amux.sessions where id = '51000000-0000-0000-0000-000000000014'),
  'cron',
  'cron source list_kind is cron'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000011';

select is(
  (select count(*)::int from amux.list_current_actor_sessions(
    p_team_id => '01000000-0000-0000-0000-000000000011',
    p_kind => 'user'
  )),
  1,
  'p_kind=user returns only ordinary sessions'
);

select is(
  (select array_agg(list_kind order by list_kind)
     from amux.list_current_actor_sessions(
       p_team_id => '01000000-0000-0000-0000-000000000011',
       p_kind => 'regular'
     )),
  array['app', 'gateway', 'user']::text[],
  'p_kind=regular still means everything except cron'
);

select * from finish();
rollback;
