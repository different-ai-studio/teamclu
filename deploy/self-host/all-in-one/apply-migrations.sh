#!/usr/bin/env sh
# Apply Supabase migrations (lexical order) then seed, idempotently.
set -euo pipefail
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
SEED_FILE="${SEED_FILE:-/seed.sql}"

# Marker table lives in a dedicated schema, NOT public: app migrations
# (e.g. move_teamclu_to_amux) relocate every public base table to amux, which
# would sweep the marker along and break tracking mid-sequence.
psql -v ON_ERROR_STOP=1 -c \
  "create schema if not exists _selfhost;
   create table if not exists _selfhost.schema_migrations(filename text primary key, applied_at timestamptz default now());"

is_applied() { # $1=filename -> "t" if present
  psql -tAc "select 1 from _selfhost.schema_migrations where filename = '$1'"
}
apply_file() { # $1=path $2=marker-name
  if [ -n "$(is_applied "$2")" ]; then
    echo "skip (already applied): $2"; return 0
  fi
  echo "apply: $2"
  psql -v ON_ERROR_STOP=1 -1 -f "$1"
  psql -v ON_ERROR_STOP=1 -c \
    "insert into _selfhost.schema_migrations(filename) values ('$2');"
}

# migrations in lexical order; skip _archive/ and non-.sql
for f in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort); do
  apply_file "$f" "$(basename "$f")"
done
# seed last — OPT-IN only. seed.sql is dev/demo fixture data (sample users,
# "Core Team", a Builder agent) with fixed ids, so it does not belong in a real
# self-host instance. Enable for a local dev stack with APPLY_SEED=true.
if [ "${APPLY_SEED:-false}" = "true" ]; then
  [ -f "$SEED_FILE" ] && apply_file "$SEED_FILE" "__seed__"
else
  echo "skip seed (APPLY_SEED != true)"
fi
echo "apply-migrations: done"
