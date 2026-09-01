#!/usr/bin/env bash
# TeamClu self-host all-in-one — SUPABASE-mode first-boot orchestrator.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

DATA_DIR="${DATA_DIR:-/data}"
RUN_DIR="${RUN_DIR:-/run/teamclu}"
SECRETS_FILE="$DATA_DIR/teamclu/secrets.env"
PGDATA="$DATA_DIR/postgres"
BASE_ENTRYPOINT=/usr/local/bin/docker-entrypoint.sh

# When the image was assembled without ENV support (e.g. a generated-Dockerfile
# corporate pipeline unpacking the vendor tarball), the nix profile is not on
# PATH yet. Prepend it here so psql/initdb resolve from their real nix paths —
# symlinking them elsewhere breaks Postgres' share-dir lookup (postgres.bki).
NIX_PROFILE_BIN=/nix/var/nix/profiles/default/bin
case ":$PATH:" in
  *":$NIX_PROFILE_BIN:"*) ;;
  *) [ -d "$NIX_PROFILE_BIN" ] && PATH="$NIX_PROFILE_BIN:$PATH" && export PATH ;;
esac

require_cmd openssl
require_cmd envsubst
require_cmd supervisord
require_cmd curl
require_cmd nc
require_cmd gosu
[ -x "$BASE_ENTRYPOINT" ] || fatal "missing base docker-entrypoint: $BASE_ENTRYPOINT"

# psql / pg_ctl / pg_isready live in the nix profile on the base image.
PSQL="$(command -v psql)"       || fatal "psql not found"
PG_CTL="$(command -v pg_ctl)"   || fatal "pg_ctl not found"
PG_ISREADY="$(command -v pg_isready)" || fatal "pg_isready not found"

ensure_dir "$DATA_DIR/teamclu"
ensure_dir "$DATA_DIR/storage"
ensure_dir "$DATA_DIR/nanomq"
ensure_dir "$DATA_DIR/caddy"
ensure_dir "$DATA_DIR/logs"
ensure_dir "$RUN_DIR"
ensure_dir /var/run/postgresql
chown postgres:postgres /var/run/postgresql "$DATA_DIR/storage" || true

make_b64_32() { rand_base64_url 32; }
make_jwt_secret() { rand_base64_url 48; }

POSTGRES_PASSWORD="$(ensure_env_value "$SECRETS_FILE" POSTGRES_PASSWORD make_b64_32)"
JWT_SECRET="$(ensure_env_value "$SECRETS_FILE" JWT_SECRET make_jwt_secret)"
if ! grep -q '^JWT_EXP=' "$SECRETS_FILE"; then write_env_value "$SECRETS_FILE" JWT_EXP 3600; fi

JWT_EXP="$(read_env_value "$SECRETS_FILE" JWT_EXP)"

# The MQTT service token (FC's broker password) is an HS256 JWT signed with the
# raw JWT_SECRET — NanoMQ's HTTP auth hook validates the password as a JWT, and
# real clients likewise present JWTs signed with the same secret.
if ! grep -q '^MQTT_SERVICE_TOKEN=' "$SECRETS_FILE"; then
  MQTT_SERVICE_TOKEN="$(jwt_sign_hs256 "$JWT_SECRET" '{"alg":"HS256","typ":"JWT"}' '{"role":"service","sub":"fc-service","iss":"teamclu","iat":1700000000,"exp":4102444800}')"
  write_env_value "$SECRETS_FILE" MQTT_SERVICE_TOKEN "$MQTT_SERVICE_TOKEN"
fi

ANON_KEY="$(jwt_sign_hs256 "$JWT_SECRET" '{"alg":"HS256","typ":"JWT"}' '{"role":"anon","iss":"supabase","iat":1700000000,"exp":4102444800}')"
SERVICE_ROLE_KEY="$(jwt_sign_hs256 "$JWT_SECRET" '{"alg":"HS256","typ":"JWT"}' '{"role":"service_role","iss":"supabase","iat":1700000000,"exp":4102444800}')"

write_env_value "$SECRETS_FILE" ANON_KEY "$ANON_KEY"
write_env_value "$SECRETS_FILE" SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"

# Render all service config/env files.
"$SCRIPT_DIR/render-config.sh"

FRESH=false
[ -s "$PGDATA/PG_VERSION" ] || FRESH=true

# ---------------------------------------------------------------------------
# Boot Postgres via the image's OWN entrypoint so first-boot init-scripts run
# (roles, auth schema+tables, extensions, storage schema). Runs in background;
# we drive migrations against it, then stop it and hand off to supervisord.
# ---------------------------------------------------------------------------
log "starting postgres (bootstrap phase, fresh=$FRESH)"
install -d -m 0700 -o postgres -g postgres "$PGDATA"
env \
  PGDATA="$PGDATA" \
  POSTGRES_HOST=/var/run/postgresql \
  POSTGRES_USER=supabase_admin \
  POSTGRES_DB=postgres \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  JWT_SECRET="$JWT_SECRET" \
  JWT_EXP="$JWT_EXP" \
  "$BASE_ENTRYPOINT" postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 -p 5432 \
    -c shared_preload_libraries=pg_net,pg_stat_statements \
  >"$DATA_DIR/logs/postgres-bootstrap.log" 2>&1 &

export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres \
       PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE=postgres POSTGRES_PASSWORD JWT_SECRET JWT_EXP

# Wait for TCP readiness (only the final long-running server binds 127.0.0.1).
i=1
until "$PG_ISREADY" -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 180 ] || { tail -n 40 "$DATA_DIR/logs/postgres-bootstrap.log" >&2 || true; fatal "postgres did not become ready"; }
  sleep 1
done
log "postgres ready"

if [ "$FRESH" = true ]; then
  log "promoting postgres role to superuser (via supabase_admin)"
  PGUSER=supabase_admin "$PSQL" -v ON_ERROR_STOP=1 \
    -c "alter role postgres with superuser createrole createdb login;"

  log "applying role passwords + jwt settings"
  "$PSQL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/roles.sql"
  "$PSQL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/jwt.sql"
  "$PSQL" -v ON_ERROR_STOP=1 -c "select pg_reload_conf();" >/dev/null

  log "migrating storage schema via storage-api (standalone)"
  set -a
  SERVER_HOST=127.0.0.1
  SERVER_PORT=5000
  ANON_KEY="$ANON_KEY"
  SERVICE_KEY="$SERVICE_ROLE_KEY"
  PGRST_JWT_SECRET="$JWT_SECRET"
  DATABASE_URL="postgres://supabase_storage_admin:$POSTGRES_PASSWORD@127.0.0.1:5432/postgres"
  DB_INSTALL_ROLES=false
  DB_SUPER_USER=postgres
  POSTGREST_URL="http://127.0.0.1:3000"
  FILE_SIZE_LIMIT=52428800
  STORAGE_BACKEND=file
  FILE_STORAGE_BACKEND_PATH=/data/storage
  TENANT_ID=stub
  REGION=stub
  GLOBAL_S3_BUCKET=stub
  ENABLE_IMAGE_TRANSFORMATION=false
  set +a
  ( cd /opt/storage && /opt/storage/bin/node dist/start/server.js \
      >"$DATA_DIR/logs/storage-migrate.log" 2>&1 ) &
  STORAGE_PID=$!
  ok=false
  j=1
  while [ "$j" -le 90 ]; do
    if curl -fsS "http://127.0.0.1:5000/health" >/dev/null 2>&1 \
       || curl -fsS "http://127.0.0.1:5000/status" >/dev/null 2>&1; then
      ok=true; break
    fi
    if [ -n "$("$PSQL" -tAc "select 1 from information_schema.tables where table_schema='storage' and table_name='buckets'" 2>/dev/null)" ]; then
      ok=true; break
    fi
    j=$((j + 1)); sleep 1
  done
  kill "$STORAGE_PID" >/dev/null 2>&1 || true
  wait "$STORAGE_PID" 2>/dev/null || true
  if [ "$ok" != true ]; then
    tail -n 40 "$DATA_DIR/logs/storage-migrate.log" >&2 || true
    fatal "storage-api did not migrate storage.* schema"
  fi
  [ -n "$("$PSQL" -tAc "select 1 from information_schema.tables where table_schema='storage' and table_name='objects'" 2>/dev/null)" ] \
    || fatal "storage.objects missing after storage-api migration"
  log "storage schema present"

  log "running GoTrue migrations (brings auth.users up to date, e.g. phone col)"
  ( set -a; . "$RUN_DIR/gotrue/env"; set +a
    exec /usr/local/bin/gotrue migrate ) \
    >"$DATA_DIR/logs/gotrue-migrate.log" 2>&1 \
    || { tail -n 40 "$DATA_DIR/logs/gotrue-migrate.log" >&2 || true; fatal "gotrue migrate failed"; }
  [ -n "$("$PSQL" -tAc "select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='phone'" 2>/dev/null)" ] \
    || fatal "auth.users.phone missing after gotrue migrate"
  log "auth schema migrated"

  log "applying real supabase migrations"
  MIGRATIONS_DIR=/opt/teamclu/supabase-migrations APPLY_SEED=false \
    bash /opt/teamclu/apply-migrations.sh

  # Supabase's default anon/authenticated statement_timeout (3s/8s) is too tight
  # for the cold PostgREST OpenAPI-root introspection on first boot. Give it
  # headroom so /rest/v1/ responds before the schema cache is warm.
  log "raising anon/authenticated statement_timeout for cold introspection"
  "$PSQL" -v ON_ERROR_STOP=1 \
    -c "alter role anon set statement_timeout='15s';" \
    -c "alter role authenticated set statement_timeout='15s';"
else
  log "existing data dir; skipping bootstrap migrations"
fi

log "stopping bootstrap postgres"
gosu postgres "$PG_CTL" -D "$PGDATA" -m fast -w stop || true
k=1
while "$PG_ISREADY" -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; do
  k=$((k + 1)); [ "$k" -le 30 ] || break; sleep 1
done

log "starting supervisor"
exec supervisord -c /etc/supervisor/conf.d/teamclu-all-in-one.conf
