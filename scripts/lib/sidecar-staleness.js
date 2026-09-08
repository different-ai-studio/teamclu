#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Is the sidecar staged in `apps/desktop/binaries/` the one this checkout would
 * build? Shared by `ensure-amuxd-sidecar` and `ensure-introspect-sidecar`.
 *
 * Both scripts used to answer from the crate version alone, and both were wrong
 * in the same way: a version is bumped at release, while the sources change
 * every day, so "same version" was read as "same binary" and the staged copy
 * survived every change that did not touch a Cargo.toml. `teamclu-introspect`
 * has the extreme case — it has been `0.1.0` since it was written, so its check
 * only ever meant "is the file there?".
 *
 * The cost of that is a `pnpm tauri:dev` launching a freshly compiled app
 * against a sidecar some earlier checkout left behind. It is what put a
 * beta.44 desktop in front of a beta.40 `amuxd` whose `doctor` predated the
 * managed runtime, and the wizard, reading the missing rows as a missing
 * runtime, wedged on "installed but not ready".
 *
 * Living here rather than in either script because having it in both is what
 * made this a bug in both.
 */

const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Directory names whose contents cannot change the built binary. */
const IGNORED_SOURCE_DIRS = new Set(["target", "node_modules", ".git"]);

function readCargoPackageVersion(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function parseVersionFromOutput(output) {
  const match = String(output ?? "").match(
    /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/,
  );
  return match ? match[1] : null;
}

/**
 * Probe `--version` with a hard timeout. A corrupted / in-place-overwritten
 * Mach-O on macOS can hang forever in UE without this.
 */
function readExecutableVersion(executable, env) {
  if (!fs.existsSync(executable)) {
    return null;
  }
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseVersionFromOutput(`${result.stdout}\n${result.stderr}`);
}

/**
 * Newest mtime under `roots`, in ms; null when none of them can be read.
 *
 * Walks rather than shelling out to git, so it sees uncommitted edits too. A
 * few hundred files per sidecar — tens of milliseconds, once per launch.
 */
function newestMtimeMs(roots) {
  let newest = null;
  const visit = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (IGNORED_SOURCE_DIRS.has(path.basename(target))) {
        return;
      }
      for (const entry of fs.readdirSync(target)) {
        visit(path.join(target, entry));
      }
      return;
    }
    if (newest === null || stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return newest;
}

/**
 * The mtime pair [`shouldRebuildSidecar`] compares, or `{}` when there is
 * nothing to compare — forced, or nothing staged yet, both of which already
 * mean "rebuild" without asking the filesystem.
 */
function mtimePair({ dest, exists, force, sourceRoots }) {
  if (force || !exists) {
    return {};
  }
  return {
    destMtimeMs: fs.statSync(dest).mtimeMs,
    sourceMtimeMs: newestMtimeMs(sourceRoots),
  };
}

/**
 * Whether to hand the build to cargo. Cargo still decides whether there is
 * anything to compile; this only decides whether to ask it — so a false
 * positive costs a no-op build, and a false negative costs a stale daemon.
 *
 * `destMtimeMs` / `sourceMtimeMs` are optional: with either missing this is the
 * version comparison on its own.
 */
function shouldRebuildSidecar({
  exists,
  expectedVersion,
  existingVersion,
  destMtimeMs,
  sourceMtimeMs,
}) {
  if (!exists) {
    return true;
  }
  if (!expectedVersion || !existingVersion) {
    return true;
  }
  if (expectedVersion !== existingVersion) {
    return true;
  }
  if (typeof destMtimeMs === "number" && typeof sourceMtimeMs === "number") {
    return sourceMtimeMs > destMtimeMs;
  }
  return false;
}

module.exports = {
  mtimePair,
  newestMtimeMs,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
};
