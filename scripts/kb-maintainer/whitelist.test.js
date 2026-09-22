"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifySource } = require("./whitelist");

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: "11111111-1111-4111-8111-111111111111",
    maintainerNodeId: "node-a",
    sources: [
      {
        prefix: "documents/handbook/",
        class: "policy",
        priority: 10,
        allowExtensions: ["md", "txt", "pdf", "docx"],
      },
      {
        prefix: "documents/training/",
        class: "training",
        priority: 20,
        allowExtensions: ["pdf", "pptx"],
      },
    ],
    deny: {
      pathPatterns: ["**/personnel/**", "**/discipline/**", "**/insurance/**"],
    },
    limits: { maxSourceBytes: 104857600 },
    ...overrides,
  };
}

test("classifySource allows a handbook pdf under the whitelist prefix", () => {
  const result = classifySource(
    { path: "documents/handbook/leave.pdf", size: 1200 },
    config(),
  );
  assert.equal(result.status, "allowed");
  assert.equal(result.class, "policy");
  assert.equal(result.priority, 10);
});

test("classifySource denies personnel paths even under a broader allow prefix", () => {
  const result = classifySource(
    { path: "documents/handbook/personnel/zhangsan.pdf", size: 100 },
    config(),
  );
  assert.equal(result.status, "denied");
  assert.match(result.reason, /deny|personnel/i);
});

test("classifySource ignores files outside every whitelist prefix", () => {
  const result = classifySource(
    { path: "documents/other/notes.md", size: 10 },
    config(),
  );
  assert.equal(result.status, "ignored");
});

test("classifySource blocks disallowed extensions", () => {
  const result = classifySource(
    { path: "documents/handbook/photo.png", size: 10 },
    config(),
  );
  assert.equal(result.status, "blocked_unsupported_extension");
});

test("classifySource blocks files over maxSourceBytes", () => {
  const result = classifySource(
    { path: "documents/handbook/huge.pdf", size: 104857601 },
    config(),
  );
  assert.equal(result.status, "blocked_too_large");
});

test("classifySource denies insurance-like filenames as supplementary filename rules", () => {
  const result = classifySource(
    { path: "documents/handbook/张三-保单.pdf", size: 80 },
    config(),
  );
  assert.equal(result.status, "denied");
  assert.match(result.reason, /filename|保单|sensitive/i);
});

test("classifySource marks unknown class prefixes as blocked_needs_classification", () => {
  const result = classifySource(
    { path: "documents/misc/notes.md", size: 10 },
    config({
      sources: [
        {
          prefix: "documents/misc/",
          class: "unknown",
          priority: 90,
          allowExtensions: ["md"],
        },
      ],
    }),
  );
  assert.equal(result.status, "blocked_needs_classification");
});
