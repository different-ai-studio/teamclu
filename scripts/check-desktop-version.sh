#!/usr/bin/env bash
# Verify the desktop version is consistent across the five places CLAUDE.md lists:
# package.json, apps/desktop/Cargo.toml, tauri.conf.json, apps/daemon/Cargo.toml,
# and Cargo.lock's `teamclu` and `amuxd` entries (CI builds with --locked).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PKG_VERSION="$(node -e "console.log(require('./package.json').version)")"
CARGO_VERSION="$(node -e "
const fs = require('fs');
const line = fs.readFileSync('apps/desktop/Cargo.toml','utf8').match(/^version\\s*=\\s*\"([^\"]+)\"/m);
if (!line) { console.error('version not found in Cargo.toml'); process.exit(1); }
console.log(line[1]);
")"
TAURI_VERSION="$(node -e "console.log(require('./apps/desktop/tauri.conf.json').version)")"
DAEMON_VERSION="$(node -e "
const fs = require('fs');
const line = fs.readFileSync('apps/daemon/Cargo.toml','utf8').match(/^version\\s*=\\s*\"([^\"]+)\"/m);
if (!line) { console.error('version not found in apps/daemon/Cargo.toml'); process.exit(1); }
console.log(line[1]);
")"

LOCK_VERSIONS="$(node -e "
const fs = require('fs');
const { readCargoLockVersions } = require('./scripts/lib/cargo-lock-version.js');
const v = readCargoLockVersions(fs.readFileSync('Cargo.lock', 'utf8'));
console.log((v.teamclu ?? 'missing') + ' ' + (v.amuxd ?? 'missing'));
")"
LOCK_TEAMCLU_VERSION="${LOCK_VERSIONS%% *}"
LOCK_AMUXD_VERSION="${LOCK_VERSIONS##* }"

echo "Desktop version sources:"
echo "  package.json:            $PKG_VERSION"
echo "  apps/desktop/Cargo.toml: $CARGO_VERSION"
echo "  tauri.conf.json:         $TAURI_VERSION"
echo "  apps/daemon/Cargo.toml:  $DAEMON_VERSION"
echo "  Cargo.lock (teamclu):    $LOCK_TEAMCLU_VERSION"
echo "  Cargo.lock (amuxd):      $LOCK_AMUXD_VERSION"

if [[ "$PKG_VERSION" == "$CARGO_VERSION" && "$CARGO_VERSION" == "$TAURI_VERSION" && "$TAURI_VERSION" == "$DAEMON_VERSION" \
  && "$DAEMON_VERSION" == "$LOCK_TEAMCLU_VERSION" && "$LOCK_TEAMCLU_VERSION" == "$LOCK_AMUXD_VERSION" ]]; then
  echo "✓ All desktop version sources match ($PKG_VERSION)"
  exit 0
fi

echo "✗ Version mismatch — run: pnpm release:bump <version>"
echo "  (if only Cargo.lock is behind: node scripts/bump-desktop-version.mjs <current-version> --allow-noop)"
exit 1
