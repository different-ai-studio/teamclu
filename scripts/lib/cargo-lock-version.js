"use strict";

/**
 * Keep `Cargo.lock`'s workspace-member entries in step with a version bump.
 *
 * `bump-desktop-version.mjs` rewrites the four canonical version sources, two of
 * which are `Cargo.toml` files. It never touched `Cargo.lock`, and the release
 * workflow commits with `git commit -am` — which only picks up files the bump
 * actually modified. So every release landed on `main` with a lockfile still
 * naming the *previous* version.
 *
 * The lockfile is not wrong for long: the next `cargo` invocation on any machine
 * rewrites those two lines. That is the problem — every developer's first build
 * after a release produces an unrequested `Cargo.lock` diff they have to stash
 * or commit around. Two such stashes were found sitting in one checkout
 * (`beta.4 → beta.6`, `beta.7 → beta.8`), both pure noise.
 *
 * Cargo would derive exactly these lines, so writing them here is not
 * hand-maintaining a lockfile — it is doing the derivation at bump time instead
 * of leaving it to whoever builds next.
 */

/**
 * Workspace members whose version tracks the desktop release version. These are
 * the two crates `bump-desktop-version.mjs` rewrites `Cargo.toml` for.
 */
const WORKSPACE_MEMBERS = ["teamclu", "amuxd"];

/**
 * Rewrite the `version` of each named package in a `Cargo.lock`'s text.
 *
 * Anchored to the `[[package]]` block header and the `name` line that follows
 * it, so a dependency that merely *mentions* one of these names cannot match.
 * Cargo always emits `name` immediately before `version` within a block.
 *
 * @param {string} lockText Contents of Cargo.lock.
 * @param {string} version Version to write.
 * @param {string[]} [packages] Package names; defaults to the workspace members.
 * @returns {{ text: string, changed: string[], missing: string[] }}
 *   `changed` lists packages whose version actually differed; `missing` lists
 *   names with no matching block, which callers should treat as a hard error —
 *   silently skipping would restore the very drift this exists to prevent.
 */
function syncCargoLockVersions(lockText, version, packages = WORKSPACE_MEMBERS) {
  const changed = [];
  const missing = [];
  let text = lockText;

  for (const name of packages) {
    // `\r?` before each newline: the Windows release runner checks out with
    // core.autocrlf=true, so Cargo.lock arrives CRLF and an \n-only pattern
    // matches nothing — every package lands in `missing` and the caller aborts.
    const block = new RegExp(
      `(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(name)}"\\r?\\nversion = ")([^"]+)(")`,
    );
    const match = text.match(block);
    if (!match) {
      missing.push(name);
      continue;
    }
    if (match[2] === version) continue;
    text = text.replace(block, `$1${version}$3`);
    changed.push(name);
  }

  return { text, changed, missing };
}

/**
 * Read the `version` of each named package from a `Cargo.lock`'s text, using
 * the same block anchor as {@link syncCargoLockVersions}.
 *
 * @param {string} lockText Contents of Cargo.lock.
 * @param {string[]} [packages] Package names; defaults to the workspace members.
 * @returns {Record<string, string | null>} `null` for a name with no block.
 */
function readCargoLockVersions(lockText, packages = WORKSPACE_MEMBERS) {
  const versions = {};
  for (const name of packages) {
    const block = new RegExp(
      `\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(name)}"\\r?\\nversion = "([^"]+)"`,
    );
    const match = lockText.match(block);
    versions[name] = match ? match[1] : null;
  }
  return versions;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { syncCargoLockVersions, readCargoLockVersions, WORKSPACE_MEMBERS };
