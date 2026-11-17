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

# Migrations that write into a schema `postgres` cannot create in. On the
# supabase/postgres 17 image `postgres` is not a superuser and `auth` belongs
# to supabase_admin, so creating auth._mint_session as `postgres` fails with
# "permission denied for schema auth" — on a fresh database only: an existing
# one applied it long ago and skips it. Those run as the role that owns the
# objects they touch. Format: one "<file>=<role>" per line.
#
# How we become that role depends on who we connected as:
# - a superuser (CI's pgTAP job connects as supabase_admin over a peer-auth
#   socket, where logging in as another role is refused) switches in-session
#   with SET ROLE, which a superuser may do to any role;
# - anyone else (self-host's `postgres`, which is not a member of these roles)
#   reconnects as the role: every Supabase role shares POSTGRES_PASSWORD
#   (supabase/volumes/db/roles.sql).
# Either way the objects end up owned by that role.
RUN_AS="
20260706000000_add_auth_mint_session.sql=supabase_auth_admin
"
role_for() { # $1=filename -> role to apply it as, or empty for the default
  printf '%s\n' "$RUN_AS" | sed -n "s/^$1=//p"
}
IS_SUPERUSER="$(psql -tAc "select rolsuper from pg_roles where rolname = current_user")"

is_applied() { # $1=filename -> "t" if present
  psql -tAc "select 1 from _selfhost.schema_migrations where filename = '$1'"
}
apply_file() { # $1=path $2=marker-name
  if [ -n "$(is_applied "$2")" ]; then
    echo "skip (already applied): $2"; return 0
  fi
  role="$(role_for "$2")"
  if [ -n "$role" ]; then
    echo "apply (as $role): $2"
    if [ "$IS_SUPERUSER" = "t" ]; then
      PGOPTIONS="${PGOPTIONS:-} -c role=$role" psql -v ON_ERROR_STOP=1 -1 -f "$1"
    else
      PGUSER="$role" psql -v ON_ERROR_STOP=1 -1 -f "$1"
    fi
  else
    echo "apply: $2"
    psql -v ON_ERROR_STOP=1 -1 -f "$1"
  fi
  psql -v ON_ERROR_STOP=1 -c \
    "insert into _selfhost.schema_migrations(filename) values ('$2');"
}

# migrations in lexical order; skip _archive/ and non-.sql
for f in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort); do
  apply_file "$f" "$(basename "$f")"
done
# seed last — OPT-IN only. seed.sql is dev/demo fixture data (sample users,
# "Core Team", a Builder agent) written against the pre-amux schema
# (public.teams etc.), so it neither belongs in a real self-host instance nor
# applies cleanly after move_teamclu_to_amux. Enable for local dev with
# APPLY_SEED=true (the seed itself may still need updating for the amux schema).
if [ "${APPLY_SEED:-false}" = "true" ]; then
  [ -f "$SEED_FILE" ] && apply_file "$SEED_FILE" "__seed__"
else
  echo "skip seed (APPLY_SEED != true)"
fi
# Migrations often add/replace RPCs PostgREST already cached. Without a reload,
# the next client call gets PGRST202 ("Could not find the function … in the
# schema cache") until rest happens to restart.
psql -v ON_ERROR_STOP=1 -c "notify pgrst, 'reload schema';" >/dev/null
echo "apply-migrations: done"
