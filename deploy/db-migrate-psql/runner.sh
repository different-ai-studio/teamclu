#!/bin/sh
set -eu
export LC_ALL=C

die() {
    printf 'psql migration: %s\n' "$1" >&2
    exit 1
}

case "${1:-apply}" in
    apply) apply=1 ;;
    preflight) apply=0 ;;
    *) die 'expected apply or preflight' ;;
esac

: "${EXPECTED_DB_HOST:?}"
: "${EXPECTED_DB_NAME:?}"
: "${EXPECTED_DB_USER:?}"
: "${EXPECTED_LEDGER_COUNT:?}"
: "${EXPECTED_LEDGER_MD5:?}"
migration_role=${MIGRATION_DB_ROLE:-$EXPECTED_DB_USER}
if [ "${PGHOST:-}" != "$EXPECTED_DB_HOST" ] ||
   [ "${PGDATABASE:-}" != "$EXPECTED_DB_NAME" ] ||
   [ "${PGUSER:-}" != "$EXPECTED_DB_USER" ]; then
    die 'database connection settings do not match the release target'
fi
printf '%s\n' "$EXPECTED_LEDGER_COUNT" | grep -Eq '^[1-9][0-9]*$' ||
    die 'expected a nonempty predecessor ledger'
printf '%s\n' "$EXPECTED_LEDGER_MD5" | grep -Eq '^[a-f0-9]{32}$' ||
    die 'invalid predecessor ledger digest'

cd "${MIGRATIONS_DIR:-/migration}"
if [ ! -s migrations.sha256 ] ||
   grep -Evq '^[a-f0-9]{64}  [0-9]{14}_[A-Za-z0-9_]+\.sql$' migrations.sha256; then
    die 'invalid migration checksum manifest'
fi
filenames=$(awk '{print $2}' migrations.sha256)
if [ "$(printf '%s\n' "$filenames" | sort -u)" != "$filenames" ]; then
    die 'migration filenames must be unique and sorted'
fi
if ! sha256sum -c migrations.sha256; then
    die 'migration bundle checksum mismatch'
fi
release_files=$(printf '%s\n' "$filenames" | paste -sd , -)

driver=$(mktemp)
trap 'rm -f "$driver"' EXIT
{
    cat <<'SQL'
SELECT current_database() = :'expected_database'
   AND session_user = :'expected_user'
   AND current_user = :'expected_user'
   AND NOT pg_is_in_recovery() AS target_matches
\gset
\if :target_matches
\else
DO $$ BEGIN RAISE EXCEPTION 'database identity does not match the release target'; END $$;
\endif

SELECT pg_try_advisory_lock(hashtextextended('_selfhost.schema_migrations', 0)) AS got_lock
\gset
\if :got_lock
\else
DO $$ BEGIN RAISE EXCEPTION 'another psql migration is running'; END $$;
\endif

WITH ledger AS (
    SELECT filename, filename = ANY(string_to_array(:'release_files', ',')) AS in_release
    FROM _selfhost.schema_migrations
),
summary AS (
    SELECT count(*) FILTER (WHERE NOT in_release) AS predecessor_count,
           md5(string_agg(filename, chr(10) ORDER BY filename COLLATE "C")
               FILTER (WHERE NOT in_release)) AS predecessor_md5,
           ARRAY(SELECT filename FROM ledger WHERE in_release ORDER BY filename COLLATE "C") AS already_applied
    FROM ledger
)
SELECT predecessor_count = :'ledger_count'::bigint
   AND coalesce(predecessor_md5, '') = :'ledger_md5'
   AND already_applied = (string_to_array(:'release_files', ','))[1:cardinality(already_applied)]
   AS history_matches
FROM summary
\gset
\if :history_matches
\else
DO $$ BEGIN RAISE EXCEPTION 'migration history does not match the release predecessor or prefix'; END $$;
\endif

SELECT has_column_privilege(current_user, '_selfhost.schema_migrations', 'filename', 'INSERT')
    AS ledger_writable
\gset
\if :ledger_writable
\else
DO $$ BEGIN RAISE EXCEPTION 'database login cannot record migration filenames'; END $$;
\endif

SELECT current_database() AS database_name, current_user AS database_role,
       inet_server_addr() AS server_address, inet_server_port() AS server_port,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls;
BEGIN READ ONLY;
SET LOCAL ROLE :"migration_role";
SELECT current_user AS migration_role;
ROLLBACK;
\if :apply
SQL

    for filename in $filenames; do
        encoded_sql=$(base64 <"$filename")
        # Server-side EXECUTE rejects embedded transaction control and psql
        # commands. Encode the file so its contents cannot break the wrapper.
        cat <<SQL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT EXISTS(SELECT FROM _selfhost.schema_migrations WHERE filename = '$filename') AS recorded
\gset
\if :recorded
\echo skip $filename
\else
\echo apply $filename
SET LOCAL ROLE :"migration_role";
DO \$teamclu\$
BEGIN
    EXECUTE convert_from(decode('$encoded_sql', 'base64'), 'UTF8');
END;
\$teamclu\$;
SET LOCAL ROLE NONE;
INSERT INTO _selfhost.schema_migrations(filename) VALUES ('$filename');
\endif
COMMIT;
SQL
    done

    cat <<'SQL'
NOTIFY pgrst, 'reload schema';
\echo psql migration complete
\else
\echo psql migration preflight passed
\endif
SQL
} >"$driver"

psql -X --no-password --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse \
    --set=expected_database="$EXPECTED_DB_NAME" --set=expected_user="$EXPECTED_DB_USER" \
    --set=migration_role="$migration_role" \
    --set=ledger_count="$EXPECTED_LEDGER_COUNT" --set=ledger_md5="$EXPECTED_LEDGER_MD5" \
    --set=release_files="$release_files" --set=apply="$apply" --file="$driver"
