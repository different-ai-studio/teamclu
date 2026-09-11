"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { planForTarget } = require("../ensure-funasr-sidecar");

const repoRoot = path.resolve(__dirname, "../..");

test("FunASR sidecar selects a reproducible macOS preparation plan", () => {
  assert.equal(planForTarget("aarch64-apple-darwin"), "build-arm64");
  assert.equal(planForTarget("x86_64-apple-darwin"), "build-intel");
  assert.equal(planForTarget("x86_64-pc-windows-msvc"), null);
});

test("Tauri bundles the architecture-matched FunASR sidecar", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "apps/desktop/tauri.macos.conf.json"), "utf8"),
  );
  assert.deepEqual(config.bundle.externalBin, [
    "binaries/teamclu-introspect",
    "binaries/amuxd",
    "binaries/llama-funasr-sensevoice",
  ]);
  assert.deepEqual(config.bundle.resources, [
    "resources/licenses/funasr-llamacpp.txt",
    "resources/licenses/sherpa-onnx-campplus.txt",
  ]);
  const base = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "apps/desktop/tauri.conf.json"), "utf8"),
  );
  assert.ok(!base.bundle.externalBin.includes("binaries/llama-funasr-sensevoice"));
});

test("both macOS release paths stage the FunASR sidecar", () => {
  for (const workflow of ["release.yml", "release-oss.yml"]) {
    const source = fs.readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8");
    assert.match(source, /ensure-funasr-sidecar\.js --target \$\{\{ matrix\.target \}\}/);
    assert.match(source, /wait \$PID_FUNASR/);
  }
});
