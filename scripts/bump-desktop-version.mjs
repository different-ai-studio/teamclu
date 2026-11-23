#!/usr/bin/env node
/**
 * Bump the desktop release version in the four manifest sources and keep the
 * `teamclu` / `amuxd` entries of Cargo.lock in step (five places in all).
 * Usage: node scripts/bump-desktop-version.mjs <version> [--allow-noop]
 * Example: node scripts/bump-desktop-version.mjs 0.2.1
 *
 * --allow-noop: exit 0 (instead of erroring) when the sources already match the
 *   requested version. Used by the beta release workflow to *sync* the four
 *   sources to the tag version before building, whether or not a bump is needed,
 *   so the bundled amuxd version always matches the advertised release.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { syncCargoLockVersions } = require('./lib/cargo-lock-version.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

const targets = [
  {
    label: 'package.json',
    path: path.join(root, 'package.json'),
    read: (raw) => JSON.parse(raw).version,
    write: (raw, version) => {
      const data = JSON.parse(raw);
      data.version = version;
      return `${JSON.stringify(data, null, 2)}\n`;
    },
  },
  {
    label: 'apps/desktop/Cargo.toml',
    path: path.join(root, 'apps/desktop/Cargo.toml'),
    read: (raw) => {
      const match = raw.match(/^version\s*=\s*"([^"]+)"/m);
      if (!match) throw new Error('version field not found in Cargo.toml');
      return match[1];
    },
    write: (raw, version) => raw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
  },
  {
    label: 'apps/desktop/tauri.conf.json',
    path: path.join(root, 'apps/desktop/tauri.conf.json'),
    read: (raw) => JSON.parse(raw).version,
    write: (raw, version) => {
      const data = JSON.parse(raw);
      data.version = version;
      return `${JSON.stringify(data, null, 2)}\n`;
    },
  },
  {
    label: 'apps/daemon/Cargo.toml',
    path: path.join(root, 'apps/daemon/Cargo.toml'),
    read: (raw) => {
      const match = raw.match(/^version\s*=\s*"([^"]+)"/m);
      if (!match) throw new Error('version field not found in Cargo.toml');
      return match[1];
    },
    write: (raw, version) => raw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
  },
];

function readCurrentVersions() {
  return targets.map((target) => {
    const raw = fs.readFileSync(target.path, 'utf8');
    return { ...target, current: target.read(raw), raw };
  });
}

const args = process.argv.slice(2);
const allowNoop = args.includes('--allow-noop');
const nextVersion = args.find((a) => !a.startsWith('--'));
if (!nextVersion) {
  const current = readCurrentVersions();
  console.error('Usage: node scripts/bump-desktop-version.mjs <version>');
  console.error('');
  console.error('Current versions:');
  for (const item of current) {
    console.error(`  ${item.label}: ${item.current}`);
  }
  process.exit(1);
}

if (!VERSION_RE.test(nextVersion)) {
  console.error(`Invalid version "${nextVersion}". Expected semver like 0.2.1 or 0.2.1-beta.1`);
  process.exit(1);
}

const items = readCurrentVersions();
const unique = [...new Set(items.map((item) => item.current))];
if (unique.length > 1) {
  console.error('Version mismatch before bump — fix manually first:');
  for (const item of items) {
    console.error(`  ${item.label}: ${item.current}`);
  }
  process.exit(1);
}

/**
 * Write the two workspace members' versions into Cargo.lock.
 *
 * Cargo derives these lines from the `Cargo.toml`s we just rewrote, so leaving
 * them stale does not break a build — it just means the next `cargo` run on any
 * machine produces an unrequested lockfile diff. That is exactly what happened
 * after every release: developers kept stashing `beta.N → beta.N+1` noise.
 *
 * Runs on the no-op path too. `release-oss.yml` calls this script with
 * `--allow-noop` precisely to *sync* sources to a tag version, and the lockfile
 * can be out of step even when the four canonical sources already agree.
 */
function syncCargoLock(version) {
  const lockPath = path.join(root, 'Cargo.lock');
  const raw = fs.readFileSync(lockPath, 'utf8');
  const { text, changed, missing } = syncCargoLockVersions(raw, version);
  if (missing.length > 0) {
    console.error(`Cargo.lock has no entry for: ${missing.join(', ')} — refusing to guess.`);
    process.exit(1);
  }
  if (changed.length === 0) {
    console.log(`✓ Cargo.lock: already at ${version}`);
    return;
  }
  fs.writeFileSync(lockPath, text);
  console.log(`✓ Cargo.lock: ${changed.join(', ')} → ${version}`);
}

const currentVersion = unique[0];
if (currentVersion === nextVersion) {
  if (allowNoop) {
    syncCargoLock(nextVersion);
    console.log(`Already at ${nextVersion}; sources in sync (--allow-noop).`);
    process.exit(0);
  }
  console.error(`Already at ${nextVersion}; nothing to do.`);
  process.exit(1);
}

for (const item of items) {
  const updated = item.write(item.raw, nextVersion);
  fs.writeFileSync(item.path, updated);
  console.log(`✓ ${item.label}: ${item.current} → ${nextVersion}`);
}

syncCargoLock(nextVersion);

console.log('');
console.log(`Desktop version bumped: ${currentVersion} → ${nextVersion}`);
console.log(`Suggested tag after merge to main: v${nextVersion}`);
