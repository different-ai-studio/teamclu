#!/usr/bin/env bash
# Upload Rust debug symbols (macOS .dSYM, Windows .pdb + .exe) to Sentry so
# desktop and amuxd crash stacks show function names and lines.
#
#   scripts/sentry-upload-debug-files.sh <file-or-dir>...
#
# Without these, Windows frames read `<unknown>` and macOS frames resolve to
# whatever exported symbol happens to sit nearby (TEAMCLU-RUST-V, -15..-18).
#
# Skips when SENTRY_AUTH_TOKEN is unset (forks, brands without the secret).
# Never fails the release: a missing symbol upload costs readable stacks, not
# a broken build.
set -uo pipefail

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "SENTRY_AUTH_TOKEN not set; skipping debug file upload."
  exit 0
fi

paths=()
for p in "$@"; do
  [ -e "$p" ] && paths+=("$p")
done
if [ "${#paths[@]}" -eq 0 ]; then
  echo "::warning::No debug files found to upload ($*)."
  exit 0
fi

echo "Uploading debug files: ${paths[*]}"
npx --yes @sentry/cli@2 debug-files upload \
  --org "${SENTRY_ORG:-ucar-inc}" \
  --project "${SENTRY_RUST_PROJECT:-teamclu-rust}" \
  --include-sources \
  "${paths[@]}" \
  || echo "::warning::Sentry debug file upload failed; crash stacks from this release will be unsymbolicated."
