# Supabase migrations

## Layout

| Path | Purpose |
|------|---------|
| `20260601000000_baseline.sql` | Full TeamClu schema (squashed from 93 pre-migration files) |
| `_archive/pre-20260601-baseline/` | Historical incremental migrations (reference only, do not apply) |
| `../tests/` | pgTAP behavioral tests |
| `../manual/` | One-off ops SQL for databases the pipeline does not reach. Deliberately outside this directory — the runner would otherwise apply it. |

## Never create a function outside a migration

`deploy/self-host/init/apply-migrations.sh` connects as `postgres`. A function
created out-of-band — via the admin MCP, Studio, or a psql session as
`supabase_admin` — ends up owned by that other role, and every later
`CREATE OR REPLACE` of it fails with:

```
ERROR: must be owner of function <name>
```

Because each migration runs as `psql -1` (single transaction), that one error
rolls back the entire file *and* blocks every migration after it. The failure
surfaces only as `service "migrate" didn't complete successfully: exit 3`, with
the actual message nowhere in the deploy log — so it reads like the newest
migration is broken when the real cause is an ownership drift from days earlier.

This happened on 2026-07-27: `amux.detach_gateway_session` had been created
manually as `supabase_admin`, which silently blocked deploys until it was
reassigned. If you hit `exit 3`, check ownership first:

```sql
select proname, pg_get_userbyid(proowner) as owner
  from pg_proc where pronamespace = 'amux'::regnamespace
 order by owner, proname;   -- everything should be owned by postgres

alter function amux.<name>(<args>) owner to postgres;   -- as a superuser
```

## Fresh database

Apply the baseline once:

```bash
# via Supabase MCP execute_sql, psql, or Studio SQL editor
\i services/supabase/migrations/20260601000000_baseline.sql
```

Record it in migration history (if your tooling expects `schema_migrations`):

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260601000000', 'baseline')
ON CONFLICT DO NOTHING;
```

## Existing Aliyun database

The production instance was built by running all archived migrations sequentially.
**Do not re-apply the baseline** — schema already matches.

Optional cleanup (only if you want a single row in `schema_migrations`):

```sql
-- DANGER: only on fresh clones, never on production with mixed history
-- TRUNCATE supabase_migrations.schema_migrations;
-- INSERT INTO supabase_migrations.schema_migrations (version, name)
-- VALUES ('20260601000000', 'baseline');
```

## New changes

Add timestamped SQL files **after** the baseline, e.g. `20260615_add_foo.sql`.

### Backward compatibility (expand-contract)

Old amuxd daemons keep running against this database, so a migration must never
break a query they still issue ([ADR-0016](../../../docs/adr/0016-fc-and-schema-changes-stay-backward-compatible.md)):

- **Add only** — new columns, new tables, nullable constraints, indexes, new
  functions. An added column needs a default or must be nullable.
- **Destructive steps are their own migrations.** Drop column / drop table /
  change type / add `NOT NULL` / change a function signature must be split into:
  add-new → dual-write / backfill → confirm nobody reads the old shape → remove.
  The intermediate state must work for both old and new callers.
- **Re-runnable.** `apply-migrations.sh` may re-apply; use `if not exists` /
  `create or replace` where the shape allows it.
- **Never assume the client already upgraded.** A migration that only works once
  every daemon is new is not an expand-contract migration.
