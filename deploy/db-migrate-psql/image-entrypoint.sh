#!/bin/sh
set -eu
export LC_ALL=C

die() {
    printf 'psql migration image: %s\n' "$1" >&2
    exit 1
}

case "${1:-}" in
    apply|preflight) [ "$#" = 1 ] || die 'expected a single command' ;;
    *) die 'expected apply or preflight' ;;
esac

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
plan=${MIGRATION_PLAN_FILE:-/release/migrations.sha256}
[ -s "$plan" ] || die 'missing or empty release manifest'

batch=$(mktemp -d)
trap 'rm -rf "$batch"' EXIT
cp "$plan" "$batch/migrations.sha256"
if grep -Evq '^[a-f0-9]{64}  [0-9]{14}_[A-Za-z0-9_]+\.sql$' "$batch/migrations.sha256"; then
    die 'invalid release manifest'
fi
filenames=$(awk '{print $2}' "$batch/migrations.sha256")
[ "$(printf '%s\n' "$filenames" | sort -u)" = "$filenames" ] ||
    die 'release filenames must be unique and sorted'
matched=$(grep -Fx -f "$here/migrations/migrations.sha256" "$batch/migrations.sha256") ||
    die 'release file does not match the image'
[ "$matched" = "$(cat "$batch/migrations.sha256")" ] ||
    die 'release file does not match the image'
for filename in $filenames; do
    cp "$here/migrations/$filename" "$batch/" 2>/dev/null ||
        die "release file does not match the image: $filename"
done
if ! (cd "$batch" && sha256sum -c migrations.sha256 >/dev/null); then
    die 'release file checksum mismatch'
fi

MIGRATIONS_DIR="$batch" sh "$here/runner.sh" "$1"
