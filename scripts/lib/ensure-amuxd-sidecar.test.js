const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  daemonSourceRoots,
  installSidecarAtomic,
} = require("../ensure-amuxd-sidecar");

// The staleness rules themselves live in lib/sidecar-staleness.test.js — this
// file covers what is specific to the daemon's sidecar.

test("daemonSourceRoots watches the crate, its path dependencies and the lockfile", () => {
  // amuxd is rebuilt when any of these move. Dropping `crates` would stage a
  // daemon built against the previous teamclu-proto and say nothing about it.
  const roots = daemonSourceRoots("/repo").map((p) => p.replace(/\\/g, "/"));
  assert.deepEqual(roots, [
    "/repo/apps/daemon",
    "/repo/crates",
    "/repo/Cargo.lock",
  ]);
});

test("installSidecarAtomic replaces dest with a new inode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-atomic-"));
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(built, "v1");
    fs.writeFileSync(dest, "old");
    const oldIno = fs.statSync(dest).ino;
    installSidecarAtomic(built, dest);
    assert.equal(fs.readFileSync(dest, "utf8"), "v1");
    assert.notEqual(fs.statSync(dest).ino, oldIno);
    assert.equal(fs.existsSync(`${dest}.tmp.${process.pid}`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
