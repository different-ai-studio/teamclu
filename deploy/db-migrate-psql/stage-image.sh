#!/bin/sh
set -eu
export LC_ALL=C
umask 022

bundle=${1:?Usage: stage-image.sh NEW_DIRECTORY}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_sql="$here/../../services/supabase/migrations"

mkdir "$bundle"
mkdir "$bundle/migrations"
cp "$here/Dockerfile" "$here/image-entrypoint.sh" "$here/runner.sh" "$bundle/"

for sql in "$source_sql"/*.sql; do
    filename=${sql##*/}
    if [ ! -f "$sql" ] || [ -L "$sql" ] ||
       ! printf '%s\n' "$filename" | grep -Eq '^[0-9]{14}_[A-Za-z0-9_]+\.sql$'; then
        printf 'Invalid migration file: %s\n' "$filename" >&2
        exit 1
    fi
    cp "$sql" "$bundle/migrations/$filename"
done
(
    cd "$bundle/migrations"
    for sql in *.sql; do
        sha256sum "$sql"
    done >migrations.sha256
)
