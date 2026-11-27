#!/bin/sh
set -eu
export LC_ALL=C

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sh "$here/stage-image.sh" "$work/bundle"
(
    cd "$work/bundle/migrations"
    sha256sum -c migrations.sha256 >/dev/null
)
git -C "$here" ls-files --full-name ':(top)services/supabase/migrations' |
    awk -F/ 'NF == 4 && /\.sql$/ {print $4}' | sort >"$work/tracked"
awk '{print $2}' "$work/bundle/migrations/migrations.sha256" >"$work/packaged"
cmp "$work/tracked" "$work/packaged"

# A fixture runner asserts exactly which files the image passes to psql.
cat >"$work/runner.sh" <<'RUNNER'
set -eu
[ "$1" = preflight ]
cd "$MIGRATIONS_DIR"
[ "$(find . -name '*.sql' | wc -l | tr -d ' ')" = 1 ]
[ "$(awk '{print $2}' migrations.sha256)" = "$TEST_SELECTED" ]
sha256sum -c migrations.sha256 >/dev/null
RUNNER
cp "$here/image-entrypoint.sh" "$work/image-entrypoint.sh"
export MIGRATION_PLAN_FILE="$work/plan"
export TMPDIR="$work"
mkdir "$work/migrations"
cp "$work/bundle/migrations/"* "$work/migrations/"
first=$(sed -n '1p' "$work/migrations/migrations.sha256")
export TEST_SELECTED=${first#*  }

reject() {
    if sh "$work/image-entrypoint.sh" preflight >"$work/error" 2>&1; then
        echo "FAIL: $1" >&2
        exit 1
    fi
    grep -F "$2" "$work/error"
}

reject 'missing plan' 'missing or empty release manifest'
: >"$MIGRATION_PLAN_FILE"
reject 'empty plan' 'missing or empty release manifest'
printf '%s\n' "$first" >"$MIGRATION_PLAN_FILE"
sh "$work/image-entrypoint.sh" preflight
printf '%s\n%s\n' "$first" "$first" >"$MIGRATION_PLAN_FILE"
reject 'duplicate file' 'must be unique and sorted'
{ sed -n '2p' "$work/migrations/migrations.sha256"; printf '%s\n' "$first"; } >"$MIGRATION_PLAN_FILE"
reject 'unsorted files' 'must be unique and sorted'
printf '%064d  20261126000000_not_in_image.sql\n' 0 >"$MIGRATION_PLAN_FILE"
reject 'unknown file' 'release file does not match the image'
printf '%064d  %s\n' 0 "$TEST_SELECTED" >"$MIGRATION_PLAN_FILE"
reject 'wrong checksum' 'release file does not match the image'
printf '%064d  ../%s\n' 0 "$TEST_SELECTED" >"$MIGRATION_PLAN_FILE"
reject 'path traversal' 'invalid release manifest'
printf '%s\n' "$first" >"$MIGRATION_PLAN_FILE"
printf '\nSELECT 1;\n' >>"$work/migrations/$TEST_SELECTED"
reject 'changed SQL inside the image' 'release file checksum mismatch'
echo 'PASS: source bundle and reviewed subset'
