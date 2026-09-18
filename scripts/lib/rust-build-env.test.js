const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const {
  createRustBuildEnv,
  ensureSccacheServer,
  isSocketListening,
} = require("../rust-build-env");

const SCRIPT_DIR = path.join(__dirname, "..");

// RUSTC_WRAPPER is passed in explicitly so these do not depend on whether the
// machine running the suite happens to have sccache on PATH.
const withSccache = (extra = {}) => ({ RUSTC_WRAPPER: "sccache", ...extra });

test("routes sccache over a unix socket instead of TCP", () => {
  const env = createRustBuildEnv(withSccache(), SCRIPT_DIR);
  assert.match(env.SCCACHE_SERVER_UDS, /^\/tmp\/sccache-\d+\.sock$/);
});

test("the socket path fits macOS sun_path (104 bytes)", () => {
  const env = createRustBuildEnv(withSccache(), SCRIPT_DIR);
  assert.ok(
    Buffer.byteLength(env.SCCACHE_SERVER_UDS) < 104,
    `socket path too long: ${env.SCCACHE_SERVER_UDS}`,
  );
});

test("an explicit SCCACHE_SERVER_UDS wins", () => {
  const env = createRustBuildEnv(
    withSccache({ SCCACHE_SERVER_UDS: "/tmp/mine.sock" }),
    SCRIPT_DIR,
  );
  assert.equal(env.SCCACHE_SERVER_UDS, "/tmp/mine.sock");
});

test("CI keeps its own sccache transport", () => {
  const env = createRustBuildEnv(withSccache({ CI: "true" }), SCRIPT_DIR);
  assert.equal(env.SCCACHE_SERVER_UDS, undefined);
});

test("a non-sccache wrapper is left alone", () => {
  const env = createRustBuildEnv({ RUSTC_WRAPPER: "some-other-wrapper" }, SCRIPT_DIR);
  assert.equal(env.SCCACHE_SERVER_UDS, undefined);
});

// Without a timeout of its own, the server exits after 10 idle minutes, and
// the next cargo run that fans out starts it from many rustc at once — the
// race `ensureSccacheServer` exists to avoid, reopened mid `tauri dev`.
test("a socket server is kept alive instead of idling out", () => {
  const env = createRustBuildEnv(withSccache(), SCRIPT_DIR);
  assert.equal(env.SCCACHE_IDLE_TIMEOUT, "0");
});

test("an explicit SCCACHE_IDLE_TIMEOUT wins", () => {
  const env = createRustBuildEnv(withSccache({ SCCACHE_IDLE_TIMEOUT: "120" }), SCRIPT_DIR);
  assert.equal(env.SCCACHE_IDLE_TIMEOUT, "120");
});

test("the TCP transport keeps sccache's own idle timeout", () => {
  const env = createRustBuildEnv(withSccache({ CI: "true" }), SCRIPT_DIR);
  assert.equal(env.SCCACHE_IDLE_TIMEOUT, undefined);
});

// ── ensureSccacheServer ──────────────────────────────────────────────────────
//
// sccache 0.16 over a Unix socket: when several rustc find no server at once,
// each starts one, and all but the first fail with
//   sccache: error: Server startup failed: File exists (os error 17)
// failing whatever crate they were compiling. Starting it once, before cargo
// fans out, closes that window.

/** A fake `spawnSync` that records calls and answers from a script. */
function fakeRun({ listening, startStatus = 0 }) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === process.execPath) return { status: listening ? 0 : 1 };
    if (cmd === "sccache") return { status: startStatus, stderr: startStatus ? "boom" : "" };
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls };
}

const udsEnv = () => ({ RUSTC_WRAPPER: "sccache", SCCACHE_SERVER_UDS: "/tmp/sccache-test.sock" });

test("starts the server once when nothing is listening on the socket", () => {
  const { run, calls } = fakeRun({ listening: false });
  const env = udsEnv();
  assert.equal(ensureSccacheServer(env, { run, log: () => {} }), "started");
  const starts = calls.filter((c) => c.cmd === "sccache");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].args, ["--start-server"]);
  assert.equal(starts[0].opts.env, env, "the server must see the same socket and cache settings");
});

// A second `--start-server` does not fail — it starts ANOTHER server that takes
// the socket over, leaving the first one orphaned. So a live server is left be.
test("leaves a server that is already listening alone", () => {
  const { run, calls } = fakeRun({ listening: true });
  assert.equal(ensureSccacheServer(udsEnv(), { run, log: () => {} }), "running");
  assert.equal(calls.filter((c) => c.cmd === "sccache").length, 0);
});

test("a failed start warns and lets the build go on", () => {
  const { run } = fakeRun({ listening: false, startStatus: 2 });
  const warnings = [];
  assert.equal(ensureSccacheServer(udsEnv(), { run, log: (m) => warnings.push(m) }), "failed");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

test("does nothing for the TCP transport or another wrapper", () => {
  const { run, calls } = fakeRun({ listening: false });
  assert.equal(ensureSccacheServer({ RUSTC_WRAPPER: "sccache" }, { run }), "skipped");
  assert.equal(
    ensureSccacheServer({ RUSTC_WRAPPER: "other", SCCACHE_SERVER_UDS: "/tmp/x.sock" }, { run }),
    "skipped",
  );
  assert.equal(calls.length, 0);
});

// The probe itself, against real sockets: the fake above only proves the
// decision; this proves the decision is fed the truth.
test("the socket probe tells a listening socket from a missing one", async () => {
  const net = require("node:net");
  const os = require("node:os");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-"));
  const sock = path.join(dir, "s.sock");
  const server = net.createServer((c) => c.destroy());
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    assert.equal(isSocketListening(sock), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(isSocketListening(sock), false, "closed and unlinked");
  assert.equal(isSocketListening(path.join(dir, "never.sock")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
