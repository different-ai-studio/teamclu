const assert = require("node:assert/strict");
const { test } = require("node:test");

const { introspectSourceRoots } = require("../ensure-introspect-sidecar");

test("introspectSourceRoots watches the crate, its path dependency and the lockfile", () => {
  // teamclu-runtime-env is a path dependency, so a change there produces a
  // different binary from an unchanged teamclu-introspect tree. The crate is
  // pinned at 0.1.0, which is exactly why mtimes have to carry this.
  const roots = introspectSourceRoots("/repo").map((p) => p.replace(/\\/g, "/"));
  assert.deepEqual(roots, [
    "/repo/apps/desktop/crates/teamclu-introspect",
    "/repo/crates/teamclu-runtime-env",
    "/repo/Cargo.lock",
  ]);
});
