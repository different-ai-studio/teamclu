"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcile } = require("./reconcile");

test("reconcile classifies add, update, delete, unchanged, and would_fetch", () => {
  const plan = reconcile({
    current: [
      { path: "documents/handbook/a.pdf", sourceSha256: "aaa", priority: 10 },
      { path: "documents/handbook/b.pdf", sourceSha256: "bbb2", priority: 10 },
      { path: "documents/training/c.pdf", priority: 20 },
    ],
    state: {
      sources: {
        "documents/handbook/a.pdf": {
          sourceSha256: "aaa",
          affectedPages: ["pages/a.md"],
        },
        "documents/handbook/b.pdf": { sourceSha256: "bbb1" },
        "documents/handbook/gone.pdf": { sourceSha256: "old" },
      },
    },
  });

  assert.deepEqual(
    plan.add.map((x) => x.path),
    [],
  );
  assert.deepEqual(
    plan.update.map((x) => x.path),
    ["documents/handbook/b.pdf"],
  );
  assert.deepEqual(
    plan.delete.map((x) => x.path),
    ["documents/handbook/gone.pdf"],
  );
  assert.deepEqual(
    plan.unchanged.map((x) => x.path),
    ["documents/handbook/a.pdf"],
  );
  assert.deepEqual(
    plan.would_fetch.map((x) => x.path),
    ["documents/training/c.pdf"],
  );
});

test("reconcile recompiles an imported source that left no wiki pages", () => {
  const plan = reconcile({
    current: [
      { path: "documents/handbook/a.pdf", sourceSha256: "aaa", priority: 10 },
    ],
    state: {
      sources: {
        "documents/handbook/a.pdf": {
          sourceSha256: "aaa",
          status: "imported",
          affectedPages: [],
        },
      },
    },
  });
  assert.deepEqual(
    plan.update.map((x) => x.path),
    ["documents/handbook/a.pdf"],
  );
  assert.deepEqual(plan.unchanged, []);
});

test("reconcile treats a hashed path absent from state as add", () => {
  const plan = reconcile({
    current: [{ path: "documents/handbook/new.pdf", sourceSha256: "abc", priority: 10 }],
    state: { sources: {} },
  });
  assert.deepEqual(
    plan.add.map((x) => x.path),
    ["documents/handbook/new.pdf"],
  );
});

test("reconcile sorts each queue by priority then path", () => {
  const plan = reconcile({
    current: [
      { path: "documents/training/z.pdf", sourceSha256: "1", priority: 20 },
      { path: "documents/handbook/b.pdf", sourceSha256: "1", priority: 10 },
      { path: "documents/handbook/a.pdf", sourceSha256: "1", priority: 10 },
    ],
    state: { sources: {} },
  });
  assert.deepEqual(
    plan.add.map((x) => x.path),
    [
      "documents/handbook/a.pdf",
      "documents/handbook/b.pdf",
      "documents/training/z.pdf",
    ],
  );
});

test("reconcile ignores extractor cache unless both sides have it", () => {
  const plan = reconcile({
    current: [
      {
        path: "documents/handbook/a.pdf",
        sourceSha256: "aaa",
        extractorCacheKey: "v2",
        priority: 10,
      },
    ],
    state: {
      sources: {
        "documents/handbook/a.pdf": {
          sourceSha256: "aaa",
          extractorCacheKey: "v1",
        },
      },
    },
  });
  assert.deepEqual(
    plan.update.map((x) => x.path),
    ["documents/handbook/a.pdf"],
  );
});
