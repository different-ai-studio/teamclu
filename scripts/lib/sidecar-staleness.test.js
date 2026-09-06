const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  mtimePair,
  newestMtimeMs,
  shouldRebuildSidecar,
} = require("../lib/sidecar-staleness");

test("rebuilds when the staged sidecar's version is older", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: "0.2.10",
      exists: true,
    }),
    true,
  );
});

test("keeps the staged sidecar when version matches and no mtimes are given", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: "0.2.16",
      exists: true,
    }),
    false,
  );
});

test("builds the sidecar when the file is missing", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: null,
      exists: false,
    }),
    true,
  );
});

test("rebuilds when the sources are newer than the staged binary", () => {
  // The version is only bumped at release, so most changes leave it untouched
  // — and used to leave the staged binary untouched with it. That is how a
  // rebuilt app ends up talking to a sidecar older than itself.
  assert.equal(
    shouldRebuildSidecar({
      exists: true,
      expectedVersion: "0.4.1-beta.44",
      existingVersion: "0.4.1-beta.44",
      destMtimeMs: 1_000,
      sourceMtimeMs: 2_000,
    }),
    true,
  );
});

test("keeps the staged binary when it is newer than every source", () => {
  assert.equal(
    shouldRebuildSidecar({
      exists: true,
      expectedVersion: "0.4.1-beta.44",
      existingVersion: "0.4.1-beta.44",
      destMtimeMs: 2_000,
      sourceMtimeMs: 1_000,
    }),
    false,
  );
});

test("a crate pinned at one version still rebuilds on a source change", () => {
  // teamclu-introspect has been 0.1.0 since it was written, so before the
  // mtime rule its staleness check could only ever answer "the file is gone".
  assert.equal(
    shouldRebuildSidecar({
      exists: true,
      expectedVersion: "0.1.0",
      existingVersion: "0.1.0",
      destMtimeMs: 1_000,
      sourceMtimeMs: 1_001,
    }),
    true,
  );
});

test("newestMtimeMs answers with the newest file and skips build output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-mtime-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "target"));
    const old = path.join(dir, "src", "main.rs");
    const recent = path.join(dir, "src", "lib.rs");
    fs.writeFileSync(old, "fn main() {}");
    fs.writeFileSync(recent, "pub fn x() {}");
    fs.utimesSync(old, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(recent, new Date(2_000_000), new Date(2_000_000));

    // A fresh build artifact must not make the tree look newer than itself —
    // that would ask cargo to rebuild on every single launch.
    const artifact = path.join(dir, "target", "amuxd");
    fs.writeFileSync(artifact, "binary");
    fs.utimesSync(artifact, new Date(9_000_000), new Date(9_000_000));

    assert.equal(newestMtimeMs([dir]), 2_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("newestMtimeMs is null when nothing is readable", () => {
  assert.equal(newestMtimeMs([path.join(os.tmpdir(), "no-such-dir-9f2c")]), null);
});

test("mtimePair does not stat anything when the answer is already 'rebuild'", () => {
  const missing = path.join(os.tmpdir(), "no-such-sidecar-4b1e");
  // `exists: false` and `force` both mean rebuild on their own; statting a
  // path that is not there would throw rather than decide anything.
  assert.deepEqual(
    mtimePair({ dest: missing, exists: false, force: false, sourceRoots: [] }),
    {},
  );
  assert.deepEqual(
    mtimePair({ dest: missing, exists: true, force: true, sourceRoots: [] }),
    {},
  );
});

test("mtimePair reads both sides when there is something to compare", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-pair-"));
  try {
    const dest = path.join(dir, "staged");
    const source = path.join(dir, "main.rs");
    fs.writeFileSync(dest, "binary");
    fs.writeFileSync(source, "fn main() {}");
    fs.utimesSync(dest, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(source, new Date(3_000_000), new Date(3_000_000));

    assert.deepEqual(
      mtimePair({ dest, exists: true, force: false, sourceRoots: [source] }),
      { destMtimeMs: 1_000_000, sourceMtimeMs: 3_000_000 },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
