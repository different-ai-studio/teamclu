#!/usr/bin/env node
"use strict";

/**
 * Strip desktop-dev-only flags and expose them via env before sidecars / tauri run.
 *
 * Usage:
 *   pnpm tauri:dev -- --skip-setup
 *   pnpm tauri:dev -- --skip-daemon-onboarding
 *   pnpm tauri:dev -- --force-amuxd
 *   pnpm tauri:dev -- --force-introspect
 *   pnpm tauri:dev:daemon
 *   pnpm tauri:dev:introspect
 *
 * Aliases: --skip-onboarding → --skip-daemon-onboarding
 *          --rebuild-daemon / --rebuild-amuxd → --force-amuxd
 *          --skip-amuxd / --no-rebuild-amuxd → --no-force-amuxd
 *          --rebuild-introspect → --force-introspect
 * Env fallbacks: TEAMCLU_SKIP_SETUP=1, TEAMCLU_SKIP_DAEMON_ONBOARDING=1,
 *                TEAMCLU_FORCE_AMUXD_SIDECAR=1 (opt in to a forced amuxd
 *                rebuild), TEAMCLU_FORCE_INTROSPECT_SIDECAR=1
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env mutated in place
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {string[]} argv with the dev-only flags removed
 */
function applyDevSkipFlags(argv, env, opts) {
  if (argv[0] !== "dev") {
    return argv;
  }
  const log = opts?.log ?? console.log;

  let skipSetup =
    env.TEAMCLU_SKIP_SETUP === "1" || env.VITE_TEAMCLU_SKIP_SETUP === "true";
  let skipDaemonOnboarding =
    env.TEAMCLU_SKIP_DAEMON_ONBOARDING === "1" ||
    env.VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING === "true";
  // Default off: every forced amuxd rebuild costs tens of seconds even when
  // warm, and ensure-amuxd-sidecar already rebuilds when daemon sources /
  // Cargo.lock are newer than the staged binary. Opt in with --force-amuxd
  // (or `pnpm tauri:dev:daemon`) when you need a guaranteed restage — e.g.
  // recovering a corrupted sidecar, or after a change the mtime walk missed.
  let forceAmuxd =
    env.TEAMCLU_FORCE_AMUXD_SIDECAR === "1" ||
    env.TEAMCLU_FORCE_AMUXD_SIDECAR === "true";
  let forceIntrospect =
    env.TEAMCLU_FORCE_INTROSPECT_SIDECAR === "1" ||
    env.TEAMCLU_FORCE_INTROSPECT_SIDECAR === "true";

  const filtered = [];
  for (const arg of argv) {
    if (arg === "--skip-setup") {
      skipSetup = true;
      continue;
    }
    if (arg === "--skip-daemon-onboarding" || arg === "--skip-onboarding") {
      skipDaemonOnboarding = true;
      continue;
    }
    if (
      arg === "--force-amuxd" ||
      arg === "--rebuild-daemon" ||
      arg === "--rebuild-amuxd"
    ) {
      forceAmuxd = true;
      continue;
    }
    if (
      arg === "--no-force-amuxd" ||
      arg === "--no-rebuild-amuxd" ||
      arg === "--skip-amuxd"
    ) {
      forceAmuxd = false;
      continue;
    }
    if (arg === "--force-introspect" || arg === "--rebuild-introspect") {
      forceIntrospect = true;
      continue;
    }
    filtered.push(arg);
  }

  if (skipSetup) {
    env.VITE_TEAMCLU_SKIP_SETUP = "true";
  }
  if (skipDaemonOnboarding) {
    env.VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING = "true";
  }
  // Written either way: an inherited TEAMCLU_FORCE_AMUXD_SIDECAR=1 must not
  // survive an explicit --no-force-amuxd.
  env.TEAMCLU_FORCE_AMUXD_SIDECAR = forceAmuxd ? "1" : "0";
  if (forceIntrospect) {
    env.TEAMCLU_FORCE_INTROSPECT_SIDECAR = "1";
  }

  log(
    `[tauri-cli] dev flags: setup_skip=${skipSetup}, daemon_onboarding_skip=${skipDaemonOnboarding}, force_amuxd=${forceAmuxd}, force_introspect=${forceIntrospect}`,
  );

  return filtered;
}

module.exports = { applyDevSkipFlags };
