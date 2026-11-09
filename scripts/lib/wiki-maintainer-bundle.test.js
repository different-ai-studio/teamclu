"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertAppHasWikiResources,
  assertMacosReleaseBundles,
  jsonMergePatch,
  macosResourceFiles,
  mergedBundleConfig,
  repoRoot,
  wikiRuntimeFiles,
} = require("./wiki-maintainer-bundle");

const maintainerRoot = path.join(repoRoot, "scripts", "kb-maintainer");

function writeTree(root, relativeFiles) {
  for (const relative of relativeFiles) {
    const abs = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
  }
}

test("JSON merge patch replaces arrays and merges objects", () => {
  const replaced = jsonMergePatch(
    { bundle: { resources: { "../../scripts/kb-maintainer": "kb-maintainer" } } },
    { bundle: { resources: ["resources/licenses/funasr-llamacpp.txt"] } },
  );
  assert.deepEqual(replaced.bundle.resources, ["resources/licenses/funasr-llamacpp.txt"]);

  const merged = jsonMergePatch(
    {
      bundle: {
        externalBin: ["binaries/amuxd"],
        resources: { "../../scripts/kb-maintainer": "kb-maintainer" },
      },
    },
    {
      bundle: {
        externalBin: ["binaries/amuxd", "binaries/llama-funasr-sensevoice"],
        resources: {
          "resources/licenses/funasr-llamacpp.txt": "resources/licenses/funasr-llamacpp.txt",
        },
      },
    },
  );
  assert.equal(merged.bundle.resources["../../scripts/kb-maintainer"], "kb-maintainer");
  assert.equal(
    merged.bundle.resources["resources/licenses/funasr-llamacpp.txt"],
    "resources/licenses/funasr-llamacpp.txt",
  );
  assert.deepEqual(merged.bundle.externalBin, [
    "binaries/amuxd",
    "binaries/llama-funasr-sensevoice",
  ]);
});

test("merged macOS Tauri config keeps Wiki scripts and FunASR licenses", () => {
  const macos = mergedBundleConfig("tauri.macos.conf.json");
  const resources = macos.bundle.resources;
  assert.equal(Array.isArray(resources), false);
  assert.equal(resources["../../scripts/kb-maintainer"], "kb-maintainer");
  assert.equal(
    resources["resources/licenses/funasr-llamacpp.txt"],
    "resources/licenses/funasr-llamacpp.txt",
  );
  assert.equal(
    resources["resources/licenses/sherpa-onnx-campplus.txt"],
    "resources/licenses/sherpa-onnx-campplus.txt",
  );
  assert.deepEqual(macos.bundle.externalBin, [
    "binaries/teamclu-introspect",
    "binaries/amuxd",
    "binaries/llama-funasr-sensevoice",
  ]);

  const windows = mergedBundleConfig("tauri.windows.conf.json");
  assert.equal(windows.bundle.resources["../../scripts/kb-maintainer"], "kb-maintainer");
});

test("runtime closure covers desktop-runner dependencies, not test files", () => {
  const files = wikiRuntimeFiles();
  for (const required of [
    "desktop-runner.js",
    "ingest.js",
    "pi-runner.js",
    "daemon-session.js",
    "checkpoint.js",
    "zip.js",
    "templates/_schema.md",
  ]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
  assert.ok(files.length > 15);
  assert.equal(
    files.some((file) => file.endsWith(".test.js") || file.startsWith("fixtures/")),
    false,
  );
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(maintainerRoot, file)), true, file);
  }
});

test("bundle expectation lists the closure and both license files", () => {
  const expected = macosResourceFiles();
  assert.ok(expected.includes("kb-maintainer/desktop-runner.js"));
  assert.ok(expected.includes("kb-maintainer/ingest.js"));
  assert.ok(expected.includes("kb-maintainer/templates/_schema.md"));
  assert.ok(expected.includes("resources/licenses/funasr-llamacpp.txt"));
  assert.ok(expected.includes("resources/licenses/sherpa-onnx-campplus.txt"));
  assert.ok(expected.filter((file) => file.startsWith("kb-maintainer/")).length > 15);
});

test("an app with only desktop-runner.js is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-bundle-"));
  const app = path.join(root, "TeamClu.app");
  const expected = macosResourceFiles();
  writeTree(path.join(app, "Contents", "Resources"), ["kb-maintainer/desktop-runner.js"]);
  assert.throws(
    () => assertAppHasWikiResources(app, expected),
    /Wiki maintenance resources are missing from this build[\s\S]*kb-maintainer\/ingest\.js[\s\S]*templates\/_schema\.md/,
  );
});

test("a complete resource tree passes, and a missing license fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-bundle-"));
  const app = path.join(root, "Branded App.app");
  const expected = macosResourceFiles();
  writeTree(path.join(app, "Contents", "Resources"), expected);
  assert.doesNotThrow(() => assertAppHasWikiResources(app, expected));
  assert.deepEqual(
    assertMacosReleaseBundles({
      repoRoot: root,
      apps: [app],
    }).map((found) => path.basename(found)),
    ["Branded App.app"],
  );
  fs.rmSync(path.join(app, "Contents", "Resources", "resources", "licenses", "funasr-llamacpp.txt"));
  assert.throws(() => assertAppHasWikiResources(app, expected), /funasr-llamacpp\.txt/);
});

test("macOS release workflows check the built app before publishing", () => {
  const tauriCli = fs.readFileSync(path.join(repoRoot, "scripts", "tauri-cli.js"), "utf8");
  assert.match(tauriCli, /assertMacosReleaseBundles/);
  for (const workflow of ["release.yml", "release-oss.yml"]) {
    const source = fs.readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8");
    assert.match(source, /tauriScript: node scripts\/tauri-cli\.js/);
    assert.match(
      source,
      /node scripts\/check-wiki-maintainer-bundle\.js --target \$\{\{ matrix\.target \}\}/,
    );
  }
});
