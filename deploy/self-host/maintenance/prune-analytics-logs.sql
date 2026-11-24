-- Run by prune.sh with -v days=N: deletes rows older than N days from every
-- Supabase Analytics (Logflare) log table in the _supabase database.
select set_config('prune.days', :'days', false) \g /dev/null
do $$
declare
  t record;
  n bigint;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = '_analytics' and table_name like 'log\_events\_%'
  loop
    execute format(
      'delete from _analytics.%I where "timestamp" < now() - make_interval(days => %s)',
      t.table_name, current_setting('prune.days')::int);
    get diagnostics n = row_count;
    if n > 0 then
      raise notice '%: deleted % row(s)', t.table_name, n;
    end if;
  end loop;
end $$;
