#!/usr/bin/env node
"use strict";

/**
 * Run a cargo subcommand against amuxd with the repo's build env and the
 * sidecar-private target directory.
 *
 * Every amuxd-only cargo invocation has to land in the SAME target dir, and it
 * must not be the one the desktop build uses — see scripts/lib/sidecar-target-dir.js
 * for why (`-p amuxd` and `-p teamclu` resolve reqwest's features differently,
 * so sharing a target dir makes the two rebuild each other's world).
 *
 * Usage: node scripts/daemon-cargo.js <run|build|test> [args...]
 *        `run` forwards its args to amuxd, everything else to cargo.
 */

const { spawn } = require("child_process");
const path = require("path");
const { createRustBuildEnv, ensureSccacheServer } = require("./rust-build-env");
const { sidecarTargetDir } = require("./lib/sidecar-target-dir");

const repoRoot = path.resolve(__dirname, "..");
const sub = process.argv[2];
const rest = process.argv.slice(3);

if (!sub) {
  console.error("usage: node scripts/daemon-cargo.js <run|build|test> [args...]");
  process.exit(2);
}

const env = createRustBuildEnv(process.env, __dirname);
env.CARGO_TARGET_DIR = sidecarTargetDir(
  env,
  path.join(repoRoot, "apps/desktop"),
  "amuxd",
);

const args =
  sub === "run"
    ? ["run", "-p", "amuxd", "--", ...rest]
    : [sub, "-p", "amuxd", ...rest];

ensureSccacheServer(env);

const child = spawn("cargo", args, {
  cwd: repoRoot,
  stdio: "inherit",
  env,
  shell: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
