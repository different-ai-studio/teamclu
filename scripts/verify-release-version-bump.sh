#!/usr/bin/env bash
# Guard: a live/beta release must bump the bundled amuxd (and desktop) version.
#
# The client only force-upgrades its ~/.amuxd/bin/amuxd when the bundled crate
# version (apps/daemon/Cargo.toml) is strictly greater than the installed one
# (see apps/daemon/src/opencode_install/mod.rs — `satisfied = installed >= bundled`).
# If a release ships with the version unchanged, the new amuxd is bundled but
# never installed. This script fails the release when:
#   1. The five version places (four manifests + Cargo.lock) disagree
#      (delegates to check-desktop-version.sh), or
#   2. The release version is not strictly greater than the previous release's.
#
# Usage:
#   scripts/verify-release-version-bump.sh <version> [current-tag]
#     <version>      release version, with or without leading 'v'
#                    (e.g. v0.2.21, 0.2.21, or 0.2.21-beta.1)
#     current-tag    the tag that triggered this run (e.g. v0.2.21), excluded
#                    from the "already released" history so a stable tag-push
#                    doesn't flag itself. Omit for channels (beta) that don't
#                    push a matching git tag.
#
# Only strict semver tags (v<major>.<minor>.<patch>[-pre]) are considered part of
# the release history — stray tags like `v1.0.0-experiment` or `v2-phase-1-done`
# are ignored so they can't skew the comparison.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-}"
CURRENT_TAG="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> [current-tag]" >&2
  exit 2
fi
# Accept a leading 'v' for convenience (tag names carry it).
VERSION="${VERSION#v}"
CURRENT_TAG="${CURRENT_TAG#v}"

# 1) All five places (package.json / desktop Cargo / tauri.conf / daemon Cargo /
#    Cargo.lock teamclu+amuxd) must already agree. This also asserts apps/daemon/Cargo.toml is in lockstep.
"$REPO_ROOT/scripts/check-desktop-version.sh"

FILE_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [[ "$FILE_VERSION" != "$VERSION" ]]; then
  echo "✗ Release version ($VERSION) does not match the version in source ($FILE_VERSION)." >&2
  echo "  Run: pnpm release:bump $VERSION" >&2
  exit 1
fi

# 2) This exact version must not already be released. Re-cutting a tag for a
#    version that already shipped means the bundled amuxd version is unchanged,
#    so clients keep running the old daemon. Fetch tags in case CI is shallow.
git fetch --tags --quiet 2>/dev/null || true

SEMVER_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
declare -a RELEASED=()
while IFS= read -r tag; do
  [[ "$tag" =~ $SEMVER_TAG_RE ]] || continue
  ver="${tag#v}"
  # Exclude the tag that triggered this run so a stable tag-push doesn't flag itself.
  [[ -n "$CURRENT_TAG" && "$ver" == "$CURRENT_TAG" ]] && continue
  RELEASED+=("$ver")
done < <(git tag --list 'v*')

for prev in "${RELEASED[@]:-}"; do
  if [[ "$prev" == "$VERSION" ]]; then
    echo "✗ Version $VERSION has already been released (tag v$VERSION exists)." >&2
    echo "  Every live/beta release MUST bump apps/daemon/Cargo.toml (bundled amuxd) so" >&2
    echo "  clients force-upgrade the daemon. Run: pnpm release:bump <next-version>" >&2
    exit 1
  fi
done

# Best-effort monotonic sanity: warn (do not fail) if this version is not the
# highest strict-semver release, so stray/back-port tags can't block a release.
if [[ ${#RELEASED[@]} -gt 0 ]]; then
  HIGHEST="$(printf '%s\n' "${RELEASED[@]}" "$VERSION" | sort -V | tail -n1)"
  if [[ "$HIGHEST" != "$VERSION" ]]; then
    echo "::warning::Release $VERSION is not the highest released version ($HIGHEST) — confirm this is an intentional back-port."
  fi
fi

echo "✓ Release version $VERSION is new (not previously released); bundled amuxd bump enforced."
