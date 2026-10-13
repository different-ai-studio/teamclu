begin;
select plan(4);

select has_table('amux', 'support_sessions', 'support_sessions exists');
select col_is_unique('amux', 'support_sessions', 'code', 'support codes are unique');

select results_eq(
  $$ select relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'amux' and c.relname = 'support_sessions' $$,
  $$ values (true) $$,
  'support_sessions has row level security');

set role authenticated;
select throws_ok(
  $$ insert into amux.support_sessions (code, status, phase, expires_at)
     values ('ABCD2345', 'waiting', 'manual', now() + interval '15 minutes') $$,
  '42501',
  'authenticated clients cannot insert support sessions'
);

select * from finish();
rollback;
