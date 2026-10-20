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

test("dryRun skips restricted folders instead of failing the run", () => {
  const fx = makeFixture();
  fs.mkdirSync(path.join(fx.documentsRoot, "handbook", "secret"), { recursive: true });
  fs.writeFileSync(path.join(fx.documentsRoot, "handbook", "secret", "pay.pdf"), "pay");
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [
      { path: "documents/handbook/secret/bonus.pdf", size: 3 },
      { path: "documents/training/onboarding.pdf", size: 5 },
    ],
    aclPrefixes: ["documents/handbook/secret/", "knowledge/hr/"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.restrictedPrefixes, ["documents/handbook/secret/"]);
  assert.equal(result.counts.restricted, 2);
  const planned = [
    ...result.plan.add,
    ...result.plan.update,
    ...result.plan.would_fetch,
    ...result.plan.unchanged,
  ].map((item) => item.path);
  assert.deepEqual(planned.sort(), [
    "documents/handbook/leave.pdf",
    "documents/training/onboarding.pdf",
  ]);
  assert.equal(JSON.stringify(result.plan).includes("secret"), false);
});

test("dryRun queues imported sources under a restricted folder for retraction, not retention", () => {
  const fx = makeFixture();
  fs.mkdirSync(path.join(fx.documentsRoot, "handbook", "secret"), { recursive: true });
  fs.writeFileSync(path.join(fx.documentsRoot, "handbook", "secret", "pay.pdf"), "pay");
  writeJson(fx.statePath, {
    schemaVersion: 1,
    teamId: "11111111-1111-4111-8111-111111111111",
    sources: {
      "documents/handbook/secret/pay.pdf": {
        status: "imported",
        sourceSha256: "ab".repeat(32),
        affectedPages: ["pages/pay.md"],
      },
      "documents/handbook/secret/bonus.pdf": {
        status: "imported",
        sourceSha256: "cd".repeat(32),
        affectedPages: ["pages/bonus.md"],
      },
    },
  });
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    // Still listed by the team: a known path must not keep restricted content alive.
    known: [{ path: "documents/handbook/secret/bonus.pdf", size: 3 }],
    aclPrefixes: ["documents/handbook/secret/"],
  });
  assert.deepEqual(
    result.plan.restrict.map((item) => item.path),
    ["documents/handbook/secret/bonus.pdf", "documents/handbook/secret/pay.pdf"],
  );
  assert.equal(result.plan.restrict[0].sourceSha256, "cd".repeat(32));
  assert.deepEqual(result.plan.delete, []);
  assert.equal(result.counts.restrict, 2);
});

test("dryRun restricts imported sources even when their folder is no longer selected", () => {
  const fx = makeFixture();
  writeJson(fx.statePath, {
    schemaVersion: 1,
    teamId: "11111111-1111-4111-8111-111111111111",
    sources: {
      "documents/finance/q1.pdf": {
        status: "imported",
        sourceSha256: "ab".repeat(32),
        affectedPages: ["pages/q1.md"],
      },
    },
  });
  fs.mkdirSync(path.join(fx.documentsRoot, "finance"), { recursive: true });
  fs.writeFileSync(path.join(fx.documentsRoot, "finance", "q1.pdf"), "q1");
  const result = dryRun({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: ["documents/finance/"],
  });
  assert.deepEqual(result.plan.restrict.map((item) => item.path), ["documents/finance/q1.pdf"]);
  assert.deepEqual(result.plan.delete, []);
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
