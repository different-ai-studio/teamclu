-- Title lock migration and amux.apply_generated_session_title.
--
-- Runs after migrations, inside a transaction that rolls back. Re-running the
-- column add here checks that a second apply does not unlock rows that a
-- person already renamed.
begin;

select plan(30);

select has_column('amux', 'sessions', 'title_locked', 'sessions.title_locked exists');
select col_type_is('amux', 'sessions', 'title_locked', 'boolean', 'title_locked is boolean');
select col_not_null('amux', 'sessions', 'title_locked', 'title_locked is required');
select col_default_is('amux', 'sessions', 'title_locked', 'false', 'title_locked defaults to false');
select has_function(
  'amux',
  'apply_generated_session_title',
  array['uuid', 'text'],
  'apply_generated_session_title(uuid, text) exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'amux.apply_generated_session_title(uuid, text)',
    'EXECUTE'
  ),
  'authenticated may apply a generated title'
);
select ok(
  has_function_privilege(
    'service_role',
    'amux.apply_generated_session_title(uuid, text)',
    'EXECUTE'
  ),
  'service_role may apply a generated title'
);
select ok(
  not has_function_privilege(
    'anon',
    'amux.apply_generated_session_title(uuid, text)',
    'EXECUTE'
  ),
  'anon cannot apply a generated title'
);
select ok(
  not has_function_privilege(
    'public',
    'amux.apply_generated_session_title(uuid, text)',
    'EXECUTE'
  ),
  'public execute was revoked'
);

insert into amux.teams (id, name, slug) values
  ('61122100-0000-4000-8000-0000000000a1', 'Title lock', 'title-lock-611221');
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('61122100-0000-4000-8000-000000000011', '61122100-0000-4000-8000-0000000000a1', 'member', 'renamer');

insert into amux.sessions (id, team_id, title, mode, created_by_actor_id) values
  ('61122100-0000-4000-8000-0000000000e1', '61122100-0000-4000-8000-0000000000a1', '', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e2', '61122100-0000-4000-8000-0000000000a1', 'New chat', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e3', '61122100-0000-4000-8000-0000000000a1', 'Agent (09:30)', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e4', '61122100-0000-4000-8000-0000000000a1', '帮我查一下深圳美食', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e5', '61122100-0000-4000-8000-0000000000a1', 'Standup (09:30)', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e6', '61122100-0000-4000-8000-0000000000a1', 'Agent (10:01)', 'collab', '61122100-0000-4000-8000-000000000011'),
  ('61122100-0000-4000-8000-0000000000e7', '61122100-0000-4000-8000-0000000000a1', 'New chat', 'collab', '61122100-0000-4000-8000-000000000011');

select is(
  (select bool_and(title_locked = false) from amux.sessions
    where id in (
      '61122100-0000-4000-8000-0000000000e1',
      '61122100-0000-4000-8000-0000000000e2',
      '61122100-0000-4000-8000-0000000000e3',
      '61122100-0000-4000-8000-0000000000e4'
    )),
  true,
  'rows that omit title_locked stay unlocked'
);

select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e1', 'From empty')),
  true,
  'an empty stored title can be replaced while unlocked'
);
select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-0000000000e1'),
  'From empty',
  'empty title was replaced'
);
select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-0000000000e1'),
  false,
  'a generated write does not lock the row'
);

select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e2', 'Standup')),
  true,
  'New chat can be replaced while unlocked'
);
select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e3', 'Launch Plan')),
  true,
  'Agent (HH:mm) can be replaced while unlocked'
);
select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e4', '深圳美食推荐')),
  true,
  'a first-message summary can be replaced while unlocked'
);
select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-0000000000e4'),
  '深圳美食推荐',
  'the summary was replaced by the generated title'
);

-- Person rename, then the in-flight generated write.
update amux.sessions
   set title = 'Standup (09:30)',
       title_locked = true
 where id = '61122100-0000-4000-8000-0000000000e6';

select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e6', '深圳美食推荐')),
  false,
  'a generated title that lands after the rename is refused'
);
select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-0000000000e6'),
  'Standup (09:30)',
  'the manual title is unchanged'
);
select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-0000000000e6'),
  true,
  'the refused write leaves the lock set'
);

select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e6', '另一条生成标题')),
  false,
  'a later generated write is still refused'
);
select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-0000000000e6'),
  true,
  'a later generated write does not clear the lock'
);

-- Generated title first, then the person renames over it.
select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e7', '深圳美食推荐')),
  true,
  'the unlocked row accepts the generated title'
);
update amux.sessions
   set title = '项目讨论',
       title_locked = true
 where id = '61122100-0000-4000-8000-0000000000e7';
select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-0000000000e7'),
  '项目讨论',
  'a later manual rename replaces the generated title'
);
select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e7', '另一条')),
  false,
  'the lock from that rename refuses the next generated title'
);

-- Already locked, as a row would be after a rename that survived the migration.
update amux.sessions
   set title_locked = true
 where id = '61122100-0000-4000-8000-0000000000e5';
select is(
  (select applied from amux.apply_generated_session_title('61122100-0000-4000-8000-0000000000e5', 'Launch Plan')),
  false,
  'a row that is already locked stays locked'
);
select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-0000000000e5'),
  'Standup (09:30)',
  'the already-locked title is unchanged'
);

select is(
  (select count(*)::int from amux.apply_generated_session_title(
    '61122100-0000-4000-8000-000000000099', 'gone')),
  0,
  'a missing session returns no row'
);

-- Second apply of the column add must not reset locks.
alter table amux.sessions
  add column if not exists title_locked boolean not null default false;
select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-0000000000e6'),
  true,
  'adding the column again does not unlock a renamed session'
);
insert into amux.sessions (id, team_id, title, mode, created_by_actor_id) values
  ('61122100-0000-4000-8000-0000000000e8', '61122100-0000-4000-8000-0000000000a1', 'New chat', 'collab', '61122100-0000-4000-8000-000000000011');
select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-0000000000e8'),
  false,
  'a session created after the column exists is still unlocked'
);

select * from finish();
rollback;
