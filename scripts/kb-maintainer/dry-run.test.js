"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dryRun } = require("./dry-run");

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-maintainer-"));
  const documentsRoot = path.join(root, "documents");
  const knowledgeRoot = path.join(root, "knowledge");
  const handbook = path.join(documentsRoot, "handbook");
  fs.mkdirSync(handbook, { recursive: true });
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  fs.writeFileSync(path.join(handbook, "leave.pdf"), "leave-v1");
  fs.writeFileSync(
    path.join(knowledgeRoot, "_schema.md"),
    "# Wiki compile rules\n\nOnly compile from provided sources.\n",
  );
  const configPath = path.join(root, "config.json");
  writeJson(configPath, {
    schemaVersion: 1,
    teamId: "11111111-1111-4111-8111-111111111111",
    maintainerNodeId: "node-a",
    sources: [
      {
        prefix: "documents/handbook/",
        class: "policy",
        priority: 10,
        allowExtensions: ["pdf"],
      },
      {
        prefix: "documents/training/",
        class: "training",
        priority: 20,
        allowExtensions: ["pdf"],
      },
    ],
    deny: { pathPatterns: ["**/personnel/**"] },
  });
  const statePath = path.join(root, "state.json");
  writeJson(statePath, { schemaVersion: 1, teamId: "11111111-1111-4111-8111-111111111111", sources: {} });
  return { root, documentsRoot, knowledgeRoot, configPath, statePath };
}

test("dryRun fails closed when ACL state is unknown", () => {
  const fx = makeFixture();
  assert.throws(
    () =>
      dryRun({
        configPath: fx.configPath,
        statePath: fx.statePath,
        documentsRoot: fx.documentsRoot,
        knowledgeRoot: fx.knowledgeRoot,
        nodeId: "node-a",
        known: [],
        aclPrefixes: null,
      }),
    /unknown|acl/i,
  );
});

test("dryRun is portable across node ids", () => {
  const fx = makeFixture();
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "other-node",
    known: [],
    aclPrefixes: [],
  });
  assert.equal(result.ok, true);
});

test("dryRun fails when _schema.md is missing", () => {
  const fx = makeFixture();
  fs.rmSync(path.join(fx.knowledgeRoot, "_schema.md"));
  assert.throws(
    () =>
      dryRun({
        configPath: fx.configPath,
        statePath: fx.statePath,
        documentsRoot: fx.documentsRoot,
        knowledgeRoot: fx.knowledgeRoot,
        nodeId: "node-a",
        known: [],
        aclPrefixes: [],
      }),
    /_schema/i,
  );
});

test("dryRun fails when a documents ACL intersects the whitelist", () => {
  const fx = makeFixture();
  assert.throws(
    () =>
      dryRun({
        configPath: fx.configPath,
        statePath: fx.statePath,
        documentsRoot: fx.documentsRoot,
        knowledgeRoot: fx.knowledgeRoot,
        nodeId: "node-a",
        known: [],
        aclPrefixes: ["documents/handbook/"],
      }),
    /acl|restricted/i,
  );
});

test("dryRun emits a stable add/would_fetch plan and is byte-identical across runs", () => {
  const fx = makeFixture();
  const opts = {
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [{ path: "documents/training/onboarding.pdf", size: 40 }],
    aclPrefixes: [],
  };
  const first = dryRun(opts);
  const second = dryRun(opts);
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.plan.add.map((x) => x.path),
    ["documents/handbook/leave.pdf"],
  );
  assert.deepEqual(
    first.plan.would_fetch.map((x) => x.path),
    ["documents/training/onboarding.pdf"],
  );
  assert.equal(typeof first.plan.add[0].sourceSha256, "string");
  assert.equal(first.plan.add[0].sourceSha256.length, 64);
  assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan));
  assert.notEqual(first.plan.add[0].sourceSha256, undefined);
});

test("dryRun does not download, call an agent, or write the vault", () => {
  const fx = makeFixture();
  const wiki = path.join(fx.knowledgeRoot, "wiki");
  dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [{ path: "documents/training/onboarding.pdf", size: 40 }],
    aclPrefixes: [],
    fetchDocuments() {
      throw new Error("must not fetch in dry-run");
    },
    runAgent() {
      throw new Error("must not call agent in dry-run");
    },
  });
  assert.equal(fs.existsSync(wiki), false);
  const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8"));
  assert.deepEqual(state.sources, {});
});

test("dryRun keeps an imported source that is listed but not downloaded", () => {
  const fx = makeFixture();
  const sha = "ab".repeat(32);
  writeJson(fx.statePath, {
    schemaVersion: 1,
    sources: {
      "documents/handbook/gone.pdf": {
        sourceSha256: sha,
        status: "imported",
        affectedPages: ["pages/gone.md"],
      },
    },
  });
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [
      { path: "documents/handbook/gone.pdf", size: 12 },
      { path: "documents/training/onboarding.pdf", size: 40 },
    ],
    aclPrefixes: [],
  });
  assert.deepEqual(result.plan.delete, []);
  assert.deepEqual(
    result.plan.would_fetch.map((item) => item.path),
    ["documents/handbook/gone.pdf", "documents/training/onboarding.pdf"],
  );
});

test("dryRun still retracts an imported source that is gone from the team", () => {
  const fx = makeFixture();
  writeJson(fx.statePath, {
    schemaVersion: 1,
    sources: {
      "documents/handbook/gone.pdf": {
        sourceSha256: "ab".repeat(32),
        status: "imported",
        affectedPages: ["pages/gone.md"],
      },
    },
  });
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [{ path: "documents/training/onboarding.pdf", size: 40 }],
    aclPrefixes: [],
  });
  assert.deepEqual(
    result.plan.delete.map((item) => item.path),
    ["documents/handbook/gone.pdf"],
  );
});

test("dryRun does not retract a listed source that is outside the selection and not downloaded", () => {
  const fx = makeFixture();
  writeJson(fx.statePath, {
    schemaVersion: 1,
    sources: {
      "documents/features/shell.md": {
        sourceSha256: "ab".repeat(32),
        status: "imported",
        affectedPages: ["pages/3col-shell.md"],
      },
    },
  });
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [{ path: "documents/features/shell.md", size: 20 }],
    aclPrefixes: [],
  });
  assert.deepEqual(result.plan.delete, []);
});

test("dryRun does not retract an imported source that still exists outside the selection", () => {
  const fx = makeFixture();
  const features = path.join(fx.documentsRoot, "features");
  fs.mkdirSync(features, { recursive: true });
  fs.writeFileSync(path.join(features, "shell.md"), "# shell\n");
  writeJson(fx.statePath, {
    schemaVersion: 1,
    sources: {
      "documents/features/shell.md": {
        sourceSha256: "ab".repeat(32),
        status: "imported",
        affectedPages: ["pages/3col-shell.md"],
      },
    },
  });
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: [],
  });
  assert.deepEqual(result.plan.delete, []);
});
