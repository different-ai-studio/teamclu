"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/release-oss.yml"),
  "utf8",
);

test("release-oss pins a stable SCCACHE_GHA_VERSION by target (not brand/tag)", () => {
  assert.match(workflow, /SCCACHE_GHA_VERSION: release-oss-1\.97\.1-\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /SCCACHE_GHA_VERSION: release-oss-1\.97\.1-x86_64-pc-windows-msvc/);
  assert.doesNotMatch(workflow, /SCCACHE_GHA_VERSION:.*inputs\.brand/);
  assert.doesNotMatch(workflow, /SCCACHE_GHA_VERSION:.*inputs\.tag/);
});

test("release-oss builds amuxd + introspect in one cargo invocation", () => {
  const unified = workflow.match(/-p amuxd -p teamclu-introspect/g) || [];
  assert.ok(unified.length >= 2, "macOS + Windows should each use a unified sidecar cargo build");
});

test("release-oss Windows prep is parallel (not three serial cargo/frontend steps)", () => {
  assert.match(workflow, /Build frontend \+ sidecars \(parallel\)/);
  assert.doesNotMatch(
    workflow,
    /name: Build teamclu-introspect sidecar[\s\S]*name: Build amuxd sidecar/,
  );
});

test("release-oss prebuilds teamclu after finalize so tauri-action can reuse it", () => {
  const finalizeIdx = workflow.indexOf("Finalize tauri.conf.json");
  const prebuildIdx = workflow.indexOf("Prebuild teamclu desktop binary");
  const tauriIdx = workflow.indexOf("uses: tauri-apps/tauri-action@v1");
  assert.ok(finalizeIdx > 0 && prebuildIdx > finalizeIdx && tauriIdx > prebuildIdx);
  assert.match(workflow, /cargo build --release --locked -p teamclu --no-default-features/);
});
