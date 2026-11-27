#!/usr/bin/env bash
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
runner=${RUNNER_UNDER_TEST:-"$here/../runner.sh"}
work=$(mktemp -d /tmp/psql-migrate-test.XXXXXX)
cleanup() {
  pg_ctl -D "$work/db" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

initdb --no-locale -U migration_test_admin -A trust -D "$work/db" >/dev/null
pg_ctl -D "$work/db" -l "$work/postgresql.log" -w \
  -o "-h '' -k $work -p 55417" start >/dev/null
export PGHOST="$work" PGPORT=55417 PGDATABASE=postgres PGUSER=migration_test
export EXPECTED_DB_HOST="$PGHOST" EXPECTED_DB_NAME="$PGDATABASE" EXPECTED_DB_USER="$PGUSER"
export MIGRATION_DB_ROLE=migration_owner
export EXPECTED_LEDGER_COUNT=1 MIGRATIONS_DIR="$work/migrations"
mkdir "$MIGRATIONS_DIR"

sql() {
  psql -XAtq -U migration_test_admin -v ON_ERROR_STOP=1 "$@"
}

sql <<'SQL'
CREATE ROLE migration_test LOGIN;
CREATE ROLE migration_owner NOLOGIN;
CREATE ROLE unrelated_owner NOLOGIN;
GRANT migration_owner TO migration_test WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
CREATE SCHEMA release_data AUTHORIZATION migration_owner;
CREATE SCHEMA _selfhost;
CREATE TABLE _selfhost.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO _selfhost.schema_migrations(filename) VALUES ('legacy.sql');
GRANT USAGE ON SCHEMA _selfhost TO migration_test;
GRANT SELECT (filename), INSERT (filename) ON _selfhost.schema_migrations TO migration_test;
ALTER TABLE _selfhost.schema_migrations ADD CONSTRAINT block_second
  CHECK (filename <> '20261126000002_second.sql');
SQL
EXPECTED_LEDGER_MD5=$(sql -c "SELECT md5('legacy.sql')")
export EXPECTED_LEDGER_MD5

printf 'CREATE TABLE release_data.first_result (id int PRIMARY KEY);\n' >"$MIGRATIONS_DIR/20261126000001_first.sql"
printf 'CREATE TABLE release_data.second_result (id int PRIMARY KEY);\nINSERT INTO release_data.second_result VALUES (1);\n' \
  >"$MIGRATIONS_DIR/20261126000002_second.sql"
(cd "$MIGRATIONS_DIR" && sha256sum ./*.sql | sed 's/  \.\//  /' >migrations.sha256)

if bash "$runner" apply >"$work/failed.log" 2>&1; then
  echo 'FAIL: ledger constraint should fail the release'
  exit 1
fi
if ! grep -q 'block_second' "$work/failed.log"; then
  cat "$work/failed.log"
  exit 1
fi

assert_sql() {
  local label=$1
  if [[ $(sql -c "$2") != t ]]; then
    echo "FAIL: $label"
    exit 1
  fi
  echo "PASS: $label"
}

assert_sql 'ledger write failure rolls back SQL in the same file' \
  "SELECT to_regclass('release_data.second_result') IS NULL AND NOT EXISTS
     (SELECT FROM _selfhost.schema_migrations WHERE filename = '20261126000002_second.sql')"
assert_sql 'previous successful file and its ledger row stay committed' \
  "SELECT to_regclass('release_data.first_result') IS NOT NULL AND EXISTS
     (SELECT FROM _selfhost.schema_migrations WHERE filename = '20261126000001_first.sql')"

sql -c 'ALTER TABLE _selfhost.schema_migrations DROP CONSTRAINT block_second'
first_before=$(sql -c "SELECT 'release_data.first_result'::regclass::oid, applied_at
  FROM _selfhost.schema_migrations WHERE filename = '20261126000001_first.sql'")
bash "$runner" preflight
assert_sql 'preflight does not apply pending SQL' "SELECT to_regclass('release_data.second_result') IS NULL"
bash "$runner" apply
assert_sql 'retry applies only the remaining file and records it once' \
  "SELECT (SELECT count(*) = 1 FROM release_data.second_result)
    AND (SELECT count(*) = 3 FROM _selfhost.schema_migrations)"
assert_sql 'DDL uses the NOLOGIN owner and ledger access stays with the login' \
  "SELECT (SELECT relowner = 'migration_owner'::regrole FROM pg_class
              WHERE oid = 'release_data.second_result'::regclass)
    AND NOT has_table_privilege('migration_owner', '_selfhost.schema_migrations', 'INSERT')"
bash "$runner" apply
[[ $(sql -c "SELECT 'release_data.first_result'::regclass::oid, applied_at
  FROM _selfhost.schema_migrations WHERE filename = '20261126000001_first.sql'") == "$first_before" ]]
assert_sql 'rerunning an already complete release preserves data and history' \
  "SELECT (SELECT count(*) = 1 FROM release_data.second_result)
    AND (SELECT count(*) = 3 FROM _selfhost.schema_migrations)"

cp "$MIGRATIONS_DIR/migrations.sha256" "$work/checked.sha256"
printf 'CREATE TABLE release_data.unsafe_result (id int);\nCOMMIT;\nSELECT 1/0;\n' \
  >"$MIGRATIONS_DIR/20261126000003_unsafe.sql"
(cd "$MIGRATIONS_DIR" && sha256sum ./*.sql | sed 's/  \.\//  /' >migrations.sha256)
if bash "$runner" apply >"$work/unsafe.log" 2>&1; then
  echo 'FAIL: a migration cannot commit its own transaction'
  exit 1
fi
assert_sql 'transaction control in a file cannot leave unrecorded changes' \
  "SELECT to_regclass('release_data.unsafe_result') IS NULL
    AND (SELECT count(*) = 3 FROM _selfhost.schema_migrations)"
mv "$work/checked.sha256" "$MIGRATIONS_DIR/migrations.sha256"

if EXPECTED_DB_NAME=wrong_db bash "$runner" preflight >"$work/identity.log" 2>&1; then
  echo 'FAIL: accepted a database other than the expected target'
  exit 1
fi
grep -q 'database connection settings do not match' "$work/identity.log"
if MIGRATION_DB_ROLE=unrelated_owner bash "$runner" preflight >"$work/role.log" 2>&1; then
  echo 'FAIL: accepted an owner role that the login cannot set'
  exit 1
fi
grep -q 'permission denied to set role' "$work/role.log"
sql -c 'REVOKE INSERT (filename) ON _selfhost.schema_migrations FROM migration_test'
if bash "$runner" preflight >"$work/ledger-acl.log" 2>&1; then
  echo 'FAIL: accepted a login that cannot record migration filenames'
  exit 1
fi
grep -q 'database login cannot record migration filenames' "$work/ledger-acl.log"
sql -c 'GRANT INSERT (filename) ON _selfhost.schema_migrations TO migration_test'
sql -c "INSERT INTO _selfhost.schema_migrations(filename) VALUES ('unexpected.sql')"
if bash "$runner" apply >"$work/drift.log" 2>&1; then
  echo 'FAIL: accepted an unexpected predecessor ledger record'
  exit 1
fi
grep -q 'history does not match' "$work/drift.log"
printf '\nSELECT 1;\n' >>"$MIGRATIONS_DIR/20261126000002_second.sql"
if bash "$runner" preflight >"$work/checksum.log" 2>&1; then
  echo 'FAIL: accepted a modified SQL file'
  exit 1
fi
grep -q 'checksum mismatch' "$work/checksum.log"
echo 'PASS: wrong target, missing privileges, ledger drift, and modified SQL fail closed'
