#!/usr/bin/env bash
# Upload the frontend's sourcemaps to Sentry, then delete them from the dist
# directory so they never ship inside the app.
#
#   scripts/sentry-upload-sourcemaps.sh <dist-dir>
#
# Run after `vite build` (with SENTRY_SOURCEMAPS=1, which makes vite emit
# hidden maps) and before the bundle step packs <dist-dir>. `sourcemaps inject`
# writes a debug id into each JS file and its map, which is how Sentry pairs
# them, so no release name has to match.
#
# Skips the upload when SENTRY_AUTH_TOKEN is unset, but always deletes the
# maps. Never fails the release.
set -uo pipefail

dist="${1:?usage: sentry-upload-sourcemaps.sh <dist-dir>}"
if [ ! -d "$dist" ]; then
  echo "::warning::$dist does not exist; nothing to upload."
  exit 0
fi

if [ -n "${SENTRY_AUTH_TOKEN:-}" ] && find "$dist" -name '*.map' -print -quit | grep . >/dev/null; then
  org="${SENTRY_ORG:-ucar-inc}"
  project="${SENTRY_WEB_PROJECT:-teamclu-react}"
  if npx --yes @sentry/cli@2 sourcemaps inject "$dist"; then
    npx --yes @sentry/cli@2 sourcemaps upload --org "$org" --project "$project" "$dist" \
      || echo "::warning::Sentry sourcemap upload failed; frontend stacks from this release stay minified."
  else
    echo "::warning::sentry-cli sourcemaps inject failed; skipping upload."
  fi
else
  echo "Skipping sourcemap upload (no SENTRY_AUTH_TOKEN or no maps)."
fi

find "$dist" -name '*.map' -delete
