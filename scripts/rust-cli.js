#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { createRustBuildEnv } = require("./rust-build-env");
const { ensureTeamcluIntrospectSidecar } = require("./ensure-introspect-sidecar");
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");

const args = process.argv.slice(2);
const env = createRustBuildEnv(process.env, __dirname);

// Analysis-only subcommands: they type-check but produce nothing to ship, so
// they have no business needing sidecar binaries or bundled resources.
const isAnalysisOnly = args[0] === "check" || args[0] === "clippy";

if (isAnalysisOnly && !env.CI) {
  // `cargo check` should be usable without downloading the local sidecar binary.
  env.CI = "1";

  if (!env.TAURI_CONFIG) {
    env.TAURI_CONFIG = JSON.stringify({
      bundle: {
        externalBin: [],
        resources: [],
      },
    });
  }
}

// introspect is a local crate.
// Build before invoking cargo to avoid build.rs deadlock. Skipped when env.CI is set (e.g. rust:check).
ensureTeamcluIntrospectSidecar(env);
ensureAmuxdSidecar(env);

const child = spawn("cargo", args, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
