#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { installSidecarIfChanged } = require("./lib/install-sidecar-atomic");
const { sidecarTargetDir } = require("./lib/sidecar-target-dir");
const {
  mtimePair,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
} = require("./lib/sidecar-staleness");

/**
 * Everything the introspect binary is built from: its own crate, the workspace
 * crate it depends on by path, and the lockfile that pins the rest.
 *
 * This one needs the mtime rule more than amuxd does, not less: the crate has
 * been `version = "0.1.0"` since it was written, so the version comparison it
 * used to rely on could only ever answer "the file is missing".
 */
function introspectSourceRoots(repoRoot) {
  return [
    path.join(repoRoot, "apps/desktop/crates/teamclu-introspect"),
    path.join(repoRoot, "crates/teamclu-runtime-env"),
    path.join(repoRoot, "Cargo.lock"),
  ];
}

/**
 * Build and install teamclu-introspect into apps/desktop/binaries/ if missing,
 * older than its sources, version-stale, or forced.
 *
 * Must run before main cargo/tauri build: build.rs panics when the file is
 * absent (unless CI is set).
 *
 * @param {NodeJS.ProcessEnv} env - Use the same env as cargo (e.g. CARGO_TARGET_DIR)
 * @param {{ logPrefix?: string, force?: boolean }} [opts]
 */
function ensureTeamcluIntrospectSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const force =
    opts?.force === true ||
    env.TEAMCLU_FORCE_INTROSPECT_SIDECAR === "1" ||
    env.TEAMCLU_FORCE_INTROSPECT_SIDECAR === "true";
  const repoRoot = path.resolve(__dirname, "..");
  const tauriDir = path.join(repoRoot, "apps/desktop");
  const target =
    env.TARGET ||
    (() => {
      const r = spawnSync("rustc", ["-vV"], { encoding: "utf8", env });
      const m = r.stdout && r.stdout.match(/host:\s*(\S+)/);
      return m ? m[1] : "";
    })();
  if (!target) {
    return;
  }
  const binName =
    process.platform === "win32" ? "teamclu-introspect.exe" : "teamclu-introspect";
  const destName =
    process.platform === "win32"
      ? `teamclu-introspect-${target}.exe`
      : `teamclu-introspect-${target}`;
  const dest = path.join(tauriDir, "binaries", destName);
  const packageManifestPath = path.join(
    tauriDir,
    "crates",
    "teamclu-introspect",
    "Cargo.toml",
  );
  const workspaceManifestPath = path.join(tauriDir, "Cargo.toml");
  if (!fs.existsSync(packageManifestPath) || !fs.existsSync(workspaceManifestPath)) {
    return;
  }
  const expectedVersion = readCargoPackageVersion(packageManifestPath);
  const exists = fs.existsSync(dest);
  // Force must skip the probe: a corrupted dest can hang even with a timeout.
  const existingVersion = force ? null : readExecutableVersion(dest, env);
  const mtimes = mtimePair({
    dest,
    exists,
    force,
    sourceRoots: introspectSourceRoots(repoRoot),
  });
  if (
    !force &&
    !shouldRebuildSidecar({ exists, expectedVersion, existingVersion, ...mtimes })
  ) {
    return;
  }
  if (force) {
    console.log(`${logPrefix} Forcing teamclu-introspect sidecar rebuild...`);
  } else if (exists && existingVersion !== expectedVersion) {
    console.log(
      `${logPrefix} Rebuilding teamclu-introspect sidecar (${existingVersion ?? "unknown"} -> ${expectedVersion ?? "unknown"})...`,
    );
  } else if (exists) {
    console.log(
      `${logPrefix} Rebuilding teamclu-introspect sidecar (crate sources changed since it was staged)...`,
    );
  }
  console.log(`${logPrefix} Building teamclu-introspect sidecar...`);
  const targetDir = sidecarTargetDir(env, tauriDir, "teamclu-introspect");
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      workspaceManifestPath,
      "-p",
      "teamclu-introspect",
      "--target-dir",
      targetDir,
    ],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build teamclu-introspect`);
    process.exit(1);
  }
  const built = path.join(targetDir, "debug", binName);
  if (installSidecarIfChanged(built, dest)) {
    console.log(`${logPrefix} Installed ${dest}`);
  } else {
    console.log(`${logPrefix} teamclu-introspect unchanged, kept staged copy`);
  }
}

module.exports = {
  ensureTeamcluIntrospectSidecar,
  introspectSourceRoots,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
};
