-- has_mention on list_current_actor_sessions_v2 (20261107000000).

begin;
select plan(2);

select has_function(
  'amux',
  'list_current_actor_sessions_v2',
  'list_current_actor_sessions_v2 still exists after has_mention migration'
);

select ok(
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'amux'
      and p.proname = 'list_current_actor_sessions_v2'
      and pg_get_function_result(p.oid) like '%has_mention%'
  ),
  'list_current_actor_sessions_v2 result type includes has_mention'
);

select * from finish();
rollback;
