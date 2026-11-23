# Supabase migrations

The TeamClu schema, as plain SQL files applied in lexical order by
`deploy/self-host/init/apply-migrations.sh`. There is no Supabase CLI in this
setup: nothing runs `supabase start`, `supabase db reset` or
`supabase migration up`, and there is no `config.toml`.

## Layout

| Path | Purpose |
|------|---------|
| `20260601000000_baseline.sql` | Squashed schema everything else builds on. Never edit it. |
| `2026*.sql` (after the baseline) | Incremental migrations, applied in lexical filename order. |
| `_archive/` | Pre-squash history (`pre-20260601-baseline/`, `squashed-20260624/`). Reference only; the runner skips subdirectories. |
| `../tests/` | pgTAP suite, run by `../tests/run.sh`. |
| `../manual/` | One-off ops SQL (prechecks, backfills) a human runs. Deliberately outside this directory — the runner would otherwise apply it. |
| `../seed.sql` | Opt-in local demo fixture (`APPLY_SEED=true`). Never applied by default. |

The business tables live in the `amux` schema (PostgREST exposes it through
`PGRST_DB_SCHEMAS`, see `deploy/self-host/.env.example`); `public` keeps the
org/user mirror tables. The database is Supabase's Postgres 17 image.

## How migrations reach each environment

**Self-host** (Docker Compose, `deploy/self-host/docker-compose.yml`): the
`migrate` service runs `apply-migrations.sh` on every `docker compose up -d`.
Each top-level `*.sql` file runs once, as `psql -1` (one transaction per
file), and is recorded in `_selfhost.schema_migrations(filename, applied_at)`.
A file already in that table is skipped, so re-running is safe — and editing
a file that has already been applied does nothing anywhere. It connects as
`postgres` (not a superuser on this image); files listed in the script's
`RUN_AS` table run as the role that owns what they touch.

**CI** (`.github/workflows/ci.yml`, "Database Tests (pgTAP)"): the same script
against a fresh container of the same image, connected as `supabase_admin`
after `../tests/ci-bootstrap.sql` stubs the GoTrue/Storage objects, then
`../tests/run.sh`. Every migration has to work under both roles.

**Belayo**: no pipeline applies migrations. They are reviewed and applied by
hand before any Cloud API release that depends on them
(`deploy/belayo/README.md`). Keep a record of what was applied there — it is
not in `_selfhost.schema_migrations`.

## Writing a migration

- New file named `YYYYMMDDHHMMSS_what_it_does.sql`, sorting after the newest
  existing file. Lexical order is the only ordering there is.
- Idempotent: `create or replace`, `if exists` / `if not exists`, guarded
  `do` blocks. Belayo may get it by hand, possibly twice.
- Never edit an applied migration or the baseline; write a new one.
- Dropping a table or column is a one-way door on production data. Put a
  read-only precheck in `../manual/`, make the migration refuse to drop a
  table that still has rows, and keep the drop in its own file so it can be
  withheld.
- When a migration drops an object, update the pgTAP files that assert it
  exists (`has_table`, `has_function`, `has_trigger`, ...).

## Never create a function outside a migration

On self-host the runner connects as `postgres`. A function created
out-of-band — via the admin MCP, Studio, or a psql session as `supabase_admin`
— ends up owned by that other role, and every later `CREATE OR REPLACE` of it
fails with:

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
 order by owner, proname;   -- on self-host everything should be owned by postgres

alter function amux.<name>(<args>) owner to postgres;   -- as a superuser
```

## Running locally

Mirror the CI job: start the pinned `ghcr.io/supabase/postgres` image, wait
for its second "ready to accept connections", run `../tests/ci-bootstrap.sql`
as `supabase_admin`, then

```bash
MIGRATIONS_DIR=services/supabase/migrations deploy/self-host/init/apply-migrations.sh
services/supabase/tests/run.sh
```

with `PGHOST`/`PGUSER=supabase_admin`/`PGPASSWORD`/`PGDATABASE` pointing at
it. Add `APPLY_SEED=true SEED_FILE=services/supabase/seed.sql` to the first
command to load the demo fixture.
