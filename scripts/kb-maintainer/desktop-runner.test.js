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
      create: ["pages/a.md", "index.md"],
      update: ["pages/b.md"],
      delete: [],
    },
  });

  assert.deepEqual(summary, {
    runId: "run-1",
    sourceCount: 3,
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
    "documents/hr/personnel/a.md: deny pattern",
    "documents/misc/a.bin: extension bin",
  ]);
});
