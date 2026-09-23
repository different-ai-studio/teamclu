"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizePreparedRun } = require("./desktop-runner");

test("summarizePreparedRun hides pipeline details behind a publish summary", () => {
  const summary = summarizePreparedRun({
    runId: "run-1",
    plan: {
      add: [{ path: "documents/handbook/a.md" }],
      update: [{ path: "documents/handbook/b.md" }],
      delete: [],
      unchanged: [{ path: "documents/handbook/c.md" }],
    },
    ingest: {
      counts: { imported: 2, rolled_back: 1, retracted: 0, unchanged: 1 },
      failures: [{ path: "documents/handbook/bad.md", error: "quality gate" }],
    },
    lint: { ok: false, errors: ["pages/a.md: dead link"], warnings: [] },
    estimate: {
      visionPages: 3,
      estimatedCost: 0.36,
      currency: "CNY",
    },
    publishPlan: {
      fromCommit: "a".repeat(40),
      toCommit: "b".repeat(40),
      baseTreeHash: "d".repeat(64),
      targetTreeHash: "c".repeat(64),
      create: ["pages/a.md", "index.md"],
      update: ["pages/b.md"],
      delete: [],
    },
  });

  assert.deepEqual(summary, {
    runId: "run-1",
    baseTreeHash: "d".repeat(64),
    targetCommit: "b".repeat(40),
    targetTreeHash: "c".repeat(64),
    sourceCount: 3,
    retractCount: 0,
    added: 1,
    updated: 1,
    deleted: 0,
    failed: 1,
    visionPages: 3,
    estimatedCost: 0.36,
    currency: "CNY",
    canPublish: false,
    blockers: [
      "documents/handbook/bad.md: quality gate",
      "pages/a.md: dead link",
    ],
  });
});

test("summarizePreparedRun lets passed pages publish while failed sources wait", () => {
  const summary = summarizePreparedRun({
    runId: "run-partial",
    plan: {
      add: [{ path: "documents/features/ok.md" }, { path: "documents/features/bad.md" }],
      update: [],
      delete: [],
      unchanged: [],
    },
    ingest: {
      counts: { imported: 1, rolled_back: 1, retracted: 0, unchanged: 0 },
      failures: [{ path: "documents/features/bad.md", error: "quality gate" }],
    },
    lint: { ok: true, errors: [], warnings: [] },
    estimate: { visionPages: 0, estimatedCost: 0, currency: "CNY" },
    publishPlan: { create: ["pages/ok.md", "index.md"], update: [], delete: [] },
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.canPublish, true);
  assert.deepEqual(summary.blockers, ["documents/features/bad.md: quality gate"]);
});

test("summarizePreparedRun counts present sources separately from retracts", () => {
  const summary = summarizePreparedRun({
    runId: "run-retract",
    plan: {
      add: [],
      update: [],
      delete: [
        { path: "documents/handbook/gone-a.md" },
        { path: "documents/handbook/gone-b.md" },
      ],
      unchanged: [{ path: "documents/handbook/kept.md" }],
    },
    ingest: { failures: [], counts: { retracted: 2, unchanged: 1 } },
    lint: { ok: true, errors: [], warnings: [] },
    estimate: { visionPages: 0, estimatedCost: 0, currency: "CNY" },
    publishPlan: { create: [], update: ["pages/kept.md"], delete: ["pages/gone.md"] },
  });

  assert.equal(summary.sourceCount, 1);
  assert.equal(summary.retractCount, 2);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.canPublish, true);
});

test("summarizePreparedRun blocks an empty source selection from publishing", () => {
  const summary = summarizePreparedRun({
    runId: "run-empty",
    plan: { add: [], update: [], delete: [], unchanged: [] },
    ingest: { failures: [] },
    lint: { ok: true, errors: [], warnings: [] },
    estimate: { visionPages: 0, estimatedCost: 0, currency: "CNY" },
    publishPlan: { create: ["index.md"], update: [], delete: [] },
  });

  assert.equal(summary.canPublish, false);
  assert.deepEqual(summary.blockers, ["No source files were found in the selected folders."]);
});

test("summarizePreparedRun blocks denied and unclassified selected sources", () => {
  const summary = summarizePreparedRun({
    runId: "run-blocked",
    plan: {
      add: [],
      update: [],
      delete: [],
      unchanged: [],
      denied: [{ path: "documents/hr/personnel/a.md", reason: "deny pattern" }],
      blocked: [{ path: "documents/misc/a.bin", reason: "extension bin" }],
    },
    ingest: { failures: [] },
    lint: { ok: true, errors: [], warnings: [] },
    estimate: { visionPages: 0, estimatedCost: 0, currency: "CNY" },
    publishPlan: { create: ["index.md"], update: [], delete: [] },
  });

  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.canPublish, false);
  assert.deepEqual(summary.blockers, [
    "documents/hr/personnel/a.md: This file is excluded from Wiki. Choose a different folder.",
    "documents/misc/a.bin: This source could not be read. Replace it with a text file, then try again.",
  ]);
});

test("summarizePreparedRun turns compiler-owned failures into one skip sentence", () => {
  const summary = summarizePreparedRun({
    runId: "run-skip",
    plan: {
      add: [{ path: "documents/handbook/a.md" }],
      update: [],
      delete: [],
      unchanged: [],
    },
    ingest: {
      failures: [
        { path: "documents/handbook/a.md", error: "compiler produced no wiki pages" },
        { path: "documents/handbook/b.md", error: "too_large" },
        { path: "documents/handbook/c.pdf", error: "extraction extraction_failed" },
      ],
    },
    lint: {
      ok: false,
      errors: [
        "pages/a.md: dead wiki link target",
        "pages/b.md: source sha256 mismatch",
      ],
      warnings: [],
    },
    estimate: { visionPages: 0, estimatedCost: 0, currency: "CNY" },
    publishPlan: { create: [], update: [], delete: [] },
  });

  assert.deepEqual(summary.blockers, [
    "documents/handbook/a.md: The compiler did not write a Wiki page for this source.",
    "documents/handbook/b.md: This source is too long. Split it into shorter files, then compile again.",
    "documents/handbook/c.pdf: This source could not be read. Replace it with a text file, then try again.",
    "This source was skipped this run and will be compiled again next time.",
  ]);
});

test("prepare emits plan → estimate → ingest → lint → done progress", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { prepare } = require("./desktop-runner");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-progress-"));
  const documentsRoot = path.join(root, "documents");
  const knowledgeRoot = path.join(root, "knowledge");
  const workRoot = path.join(root, "work");
  fs.mkdirSync(path.join(documentsRoot, "handbook"), { recursive: true });
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  fs.mkdirSync(path.join(workRoot, "state"), { recursive: true });
  fs.writeFileSync(path.join(knowledgeRoot, "_schema.md"), "# rules\n");
  fs.writeFileSync(path.join(documentsRoot, "handbook", "leave.md"), "# 请假\n\n提前申请。\n");
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      teamId: "11111111-1111-4111-8111-111111111111",
      maintainerNodeId: "node-a",
      sources: [
        {
          prefix: "documents/handbook/",
          class: "policy",
          priority: 1,
          allowExtensions: ["md"],
        },
      ],
      deny: { pathPatterns: [] },
    }),
  );
  fs.writeFileSync(
    path.join(workRoot, "state", "state.json"),
    JSON.stringify({ schemaVersion: 1, sources: {} }),
  );

  const events = [];
  const checkpoints = [];
  const summary = await prepare(
    {
      runId: "run-progress",
      expectedGeneration: 7,
      configVersion: 3,
      configPath: path.join(root, "config.json"),
      statePath: path.join(workRoot, "state", "state.json"),
      documentsRoot,
      knowledgeRoot,
      workRoot,
      nodeId: "node-a",
      known: [],
      aclPrefixes: [],
      compilerModel: "default",
      runner: "fake",
    },
    {
      onProgress: (event) => events.push(event),
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    },
  );

  assert.deepEqual(
    events.map((event) => event.stage),
    ["plan", "estimate", "ingest", "lint", "done"],
  );
  assert.equal(events[2].current, 1);
  assert.equal(events[2].total, 1);
  assert.equal(events[2].path, "documents/handbook/leave.md");
  assert.equal(events[2].action, "add");
  assert.deepEqual(
    checkpoints.map((checkpoint) => ({
      generation: checkpoint.manifest.generation,
      readyToPublish: checkpoint.manifest.readyToPublish,
    })),
    [
      { generation: 8, readyToPublish: false },
      { generation: 9, readyToPublish: true },
    ],
  );
  assert.equal(checkpoints[1].preparedRun.runId, summary.runId);
});
