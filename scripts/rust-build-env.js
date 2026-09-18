"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveBuildEnv } = require("./lib/resolve-build-env");

function findRepoRoot(startDir) {
  let current = startDir;

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && fs.existsSync(path.join(current, "package.json"))) {
      // In a git worktree, .git is a file containing "gitdir: <path>".
      // Keep build artifacts scoped to the active checkout: Cargo/Tauri build
      // metadata can contain absolute source paths, and sharing a target dir
      // across worktrees can make builds read files from deleted checkouts.
      try {
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            return current;
          }
        }
      } catch (_) {
        // Fall through to return current worktree root
      }
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

function commandExists(command) {
  const pathEnv = process.env.PATH || "";
  const suffixes = process.platform === "win32"
    ? [".exe", ".cmd", ".bat", ""]
    : [""];

  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, command + suffix);
      if (fs.existsSync(candidate)) {
        return true;
      }
    }
  }

  return false;
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function createRustBuildEnv(baseEnv = process.env, scriptDir = __dirname) {
  const env = { ...baseEnv };
  const repoRoot = findRepoRoot(scriptDir);

  const resolvedBuildEnv = resolveBuildEnv(repoRoot, env);
  if (resolvedBuildEnv && !env.BUILD_ENV) {
    env.BUILD_ENV = resolvedBuildEnv;
  }

  // Mirror Vite: packages/app/.env.local overrides for Rust build.rs (CLOUD_API_URL).
  // Without this, the JS frontend talks to 127.0.0.1:9000 while team-share Tauri
  // commands still hit build.config.json cloudApiUrl → PGRST301 on the remote FC.
  const appEnvDir = path.join(repoRoot, "packages", "app");
  for (const name of [".env.local", ".env"]) {
    for (const [key, val] of Object.entries(loadDotEnvFile(path.join(appEnvDir, name)))) {
      if (env[key] === undefined || env[key] === "") {
        env[key] = val;
      }
    }
  }

  // Only override CARGO_TARGET_DIR locally. In CI, leave cargo's own default in
  // place — apps/desktop is a root workspace member, so that default is the
  // workspace root target/, which is where tauri-action discovers the bundle.
  if (!env.CARGO_TARGET_DIR && !baseEnv.GITHUB_ACTIONS) {
    env.CARGO_TARGET_DIR = path.join(repoRoot, ".cargo-target");
  }

  if (!env.RUSTC_WRAPPER && commandExists("sccache")) {
    env.RUSTC_WRAPPER = "sccache";
  }

  // Talk to the sccache server over a Unix socket instead of TCP 127.0.0.1:4226.
  //
  // Every rustc invocation opens (and closes) one connection to the server, and
  // each closed socket sits in TIME_WAIT. A full build of this workspace burns
  // through the whole macOS ephemeral range (49152-65535, 16k ports) faster than
  // it drains — measured 15,950 sockets in TIME_WAIT, 3,221 of them on 4226 —
  // after which connect() returns EADDRNOTAVAIL and the build does not merely
  // slow down, it FAILS:
  //
  //   sccache: error: Can't assign requested address (os error 49)
  //   error: could not compile `tokio-util` (lib)
  //
  // A Unix socket uses no ephemeral port at all. Left to CI's own setup, which
  // manages its sccache separately.
  if (
    env.RUSTC_WRAPPER === "sccache" &&
    !env.SCCACHE_SERVER_UDS &&
    process.platform !== "win32" &&
    !baseEnv.CI
  ) {
    // Keep it short: macOS caps sun_path at 104 bytes.
    env.SCCACHE_SERVER_UDS = `/tmp/sccache-${process.getuid?.() ?? 0}.sock`;
  }

  // Keep a socket server running rather than letting it exit after its default
  // 10 idle minutes. `ensureSccacheServer` starts it before cargo fans out, but
  // a `tauri dev` session rebuilds on its own long after that — and a rebuild
  // that finds no server reopens the startup race described there.
  if (env.SCCACHE_SERVER_UDS && env.RUSTC_WRAPPER === "sccache" && !env.SCCACHE_IDLE_TIMEOUT) {
    env.SCCACHE_IDLE_TIMEOUT = "0";
  }

  if (process.platform === "darwin" && process.arch === "arm64" && !env.BINDGEN_EXTRA_CLANG_ARGS) {
    env.BINDGEN_EXTRA_CLANG_ARGS = "--target=aarch64-apple-darwin";
  }

  if (process.platform === "darwin" && !env.CMAKE_OSX_DEPLOYMENT_TARGET) {
    env.CMAKE_OSX_DEPLOYMENT_TARGET = "10.15";
  }

  return env;
}

/**
 * Whether something accepts connections on this Unix socket.
 *
 * A real connect, because nothing cheaper answers the question: the socket file
 * outlives a server that was killed, and `sccache --show-stats` exits 0 with
 * all-zero counters whether or not a server is there. Run in a child so the
 * callers — plain synchronous scripts — can stay synchronous.
 */
function isSocketListening(socketPath, run = spawnSync) {
  const probe = run(
    process.execPath,
    [
      "-e",
      'const s = require("net").connect(process.argv[1]);' +
        's.on("connect", () => { s.destroy(); process.exit(0); });' +
        's.on("error", () => process.exit(1));',
      socketPath,
    ],
    { stdio: "ignore", timeout: 5000 },
  );
  return probe.status === 0;
}

/**
 * Start the sccache server before cargo runs, when it talks over a Unix socket.
 *
 * Left to itself, the server is started by whichever rustc finds it missing —
 * and cargo launches many at once. Over a Unix socket (see `createRustBuildEnv`)
 * sccache 0.16 does not survive that: every starter but one fails to bind with
 *
 *   sccache: error: Server startup failed: File exists (os error 17)
 *   error: could not compile `shlex` (lib)
 *
 * so a build that begins with no server running fails at random. Reproduced with
 * twelve concurrent `sccache --start-server`: three failed, one exactly as above.
 *
 * A running server is left alone: `--start-server` against a live socket does
 * not fail, it starts a SECOND server that takes the socket over and orphans the
 * first. A stale socket file is fine — sccache replaces it.
 *
 * Never fatal. If this cannot start the server, cargo is no worse off than
 * before, so it warns and returns.
 */
function ensureSccacheServer(env, { run = spawnSync, log = console.warn } = {}) {
  if (env.RUSTC_WRAPPER !== "sccache" || !env.SCCACHE_SERVER_UDS) return "skipped";
  if (isSocketListening(env.SCCACHE_SERVER_UDS, run)) return "running";

  const started = run("sccache", ["--start-server"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  if (started.status === 0) return "started";

  const why = (started.stderr || started.error?.message || `exit ${started.status}`).trim();
  log(`[rust-build-env] could not start sccache ahead of cargo (${why}); continuing without it`);
  return "failed";
}

module.exports = {
  createRustBuildEnv,
  ensureSccacheServer,
  isSocketListening,
};
