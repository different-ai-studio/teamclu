#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  installSidecarAtomic,
  installSidecarIfChanged,
} = require("./lib/install-sidecar-atomic");
const { sidecarTargetDir } = require("./lib/sidecar-target-dir");
const {
  mtimePair,
  newestMtimeMs,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
} = require("./lib/sidecar-staleness");

/**
 * Everything the daemon binary is built from: its own crate, the workspace
 * crates it depends on by path, and the lockfile that pins the rest. A staged
 * sidecar older than any of these was built from something else.
 */
function daemonSourceRoots(repoRoot) {
  return [
    path.join(repoRoot, "apps/daemon"),
    path.join(repoRoot, "crates"),
    path.join(repoRoot, "Cargo.lock"),
  ];
}

/**
 * Build and install amuxd into apps/desktop/binaries/amuxd-<target> if missing.
 * Mirrors ensureTeamcluIntrospectSidecar so tauri bundling finds the sidecar.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ logPrefix?: string, force?: boolean }} [opts]
 */
function ensureAmuxdSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const force =
    opts?.force === true ||
    env.TEAMCLU_FORCE_AMUXD_SIDECAR === "1" ||
    env.TEAMCLU_FORCE_AMUXD_SIDECAR === "true";
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
  const binName = process.platform === "win32" ? "amuxd.exe" : "amuxd";
  const destName = process.platform === "win32" ? `amuxd-${target}.exe` : `amuxd-${target}`;
  const dest = path.join(tauriDir, "binaries", destName);
  const manifestPath = path.join(repoRoot, "apps/daemon", "Cargo.toml");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const expectedVersion = readCargoPackageVersion(manifestPath);
  const exists = fs.existsSync(dest);
  // Force must skip the probe: a corrupted dest hangs forever even with a
  // timeout if the kernel parks the probe in UE before the timer fires.
  const existingVersion = force ? null : readExecutableVersion(dest, env);
  const mtimes = mtimePair({
    dest,
    exists,
    force,
    sourceRoots: daemonSourceRoots(repoRoot),
  });
  if (
    !force &&
    !shouldRebuildSidecar({
      exists,
      expectedVersion,
      existingVersion,
      ...mtimes,
    })
  ) {
    return;
  }
  if (force) {
    console.log(`${logPrefix} Forcing amuxd sidecar rebuild...`);
  } else if (exists && existingVersion !== expectedVersion) {
    console.log(
      `${logPrefix} Rebuilding amuxd sidecar (${existingVersion ?? "unknown"} -> ${expectedVersion ?? "unknown"})...`,
    );
  } else if (exists) {
    console.log(
      `${logPrefix} Rebuilding amuxd sidecar (daemon sources changed since it was staged)...`,
    );
  }
  console.log(`${logPrefix} Building amuxd sidecar...`);
  const targetDir = sidecarTargetDir(env, tauriDir, "amuxd");
  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", manifestPath, "-p", "amuxd", "--target-dir", targetDir],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build amuxd`);
    process.exit(1);
  }
  const built = path.join(targetDir, "debug", binName);
  if (installSidecarIfChanged(built, dest)) {
    console.log(`${logPrefix} Installed ${dest}`);
  } else {
    console.log(`${logPrefix} amuxd unchanged, kept staged copy`);
  }
}

module.exports = {
  daemonSourceRoots,
  ensureAmuxdSidecar,
  installSidecarAtomic, // re-export for callers/tests
  newestMtimeMs,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
};
