-- sessions.title_locked and the single-statement generated-title update.
begin;

select plan(8);

select has_column('amux', 'sessions', 'title_locked', 'sessions.title_locked exists');
select col_type_is('amux', 'sessions', 'title_locked', 'boolean', 'title_locked is boolean');
select col_not_null('amux', 'sessions', 'title_locked', 'title_locked is required');
select col_default_is('amux', 'sessions', 'title_locked', 'false', 'title_locked defaults to false');
select has_function(
  'amux',
  'apply_generated_session_title',
  array['uuid', 'text'],
  'apply_generated_session_title exists'
);

insert into amux.teams (id, name, slug) values
  ('61122100-0000-4000-8000-0000000000a1', 'Title lock', 'title-lock-611221');
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('61122100-0000-4000-8000-000000000011', '61122100-0000-4000-8000-0000000000a1', 'member', 'renamer');
insert into amux.sessions (id, team_id, title, mode, created_by_actor_id) values
  ('61122100-0000-4000-8000-000000000021', '61122100-0000-4000-8000-0000000000a1', 'Agent (09:30)', 'collab', '61122100-0000-4000-8000-000000000011');

select is(
  (select title_locked from amux.sessions where id = '61122100-0000-4000-8000-000000000021'),
  false,
  'a new session is unlocked'
);

update amux.sessions
   set title = 'Standup (09:30)',
       title_locked = true
 where id = '61122100-0000-4000-8000-000000000021';

select results_eq(
  $$select applied, title, title_locked
      from amux.apply_generated_session_title(
        '61122100-0000-4000-8000-000000000021',
        '深圳美食推荐'
      )$$,
  $$values (false, 'Standup (09:30)'::text, true)$$,
  'a generated title does not replace a locked title'
);

select is(
  (select title from amux.sessions where id = '61122100-0000-4000-8000-000000000021'),
  'Standup (09:30)',
  'the locked title is still the stored title'
);

select * from finish();
rollback;
