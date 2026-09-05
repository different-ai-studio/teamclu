#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { createRustBuildEnv } = require("./rust-build-env");
const { ensureTeamcluIntrospectSidecar } = require("./ensure-introspect-sidecar");
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");
const { applyDevSkipFlags } = require("./lib/dev-flags");
const { platform } = process;

let args = process.argv.slice(2);
const isWindows = platform === "win32";
const sub = args[0];

// On Windows, dev/build must use --no-default-features to avoid wmi/windows-core conflict (p2p/iroh).
// Strip any --features p2p so the broken dependency is not pulled in.
if (isWindows && (sub === "dev" || sub === "build")) {
  const filtered = args.filter((a, i) => {
    if (a === "--features" && args[i + 1] === "p2p") return false;
    if (a === "p2p" && args[i - 1] === "--features") return false;
    return true;
  });
  if (!filtered.includes("--no-default-features")) {
    const dashIdx = filtered.indexOf("--");
    const cargoFlags = ["--no-default-features"];
    if (dashIdx >= 0) {
      filtered.splice(dashIdx + 1, 0, ...cargoFlags);
    } else {
      filtered.push("--", ...cargoFlags);
    }
  }
  args.length = 0;
  args.push(...filtered);
}

const env = createRustBuildEnv(process.env, __dirname);
args = applyDevSkipFlags(args, env);
ensureTeamcluIntrospectSidecar(env, { logPrefix: "[tauri-cli]" });
ensureAmuxdSidecar(env, { logPrefix: "[tauri-cli]" });

const desktopDir = path.resolve(__dirname, "..", "apps", "desktop");
const child = spawn("pnpm", ["exec", "tauri", ...args], {
  stdio: "inherit",
  shell: isWindows,
  env,
  cwd: desktopDir,
});
child.on("exit", (code) => process.exit(code ?? 0));
