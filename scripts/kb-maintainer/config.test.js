"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConfig } = require("./config");

function valid(overrides = {}) {
  return {
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
    ],
    deny: { pathPatterns: ["**/personnel/**"] },
    ...overrides,
  };
}

test("parseConfig fills default limits including the Slice 1 review values", () => {
  const cfg = parseConfig(valid());
  assert.equal(cfg.limits.maxPagesChangedPerSource, 15);
  assert.equal(cfg.limits.maxExtractedChars, 50000);
  assert.equal(cfg.limits.maxIndexChars, 8000);
  assert.equal(cfg.limits.maxSourceSummaryChars, 4000);
  assert.equal(cfg.limits.maxSourceSummaryPagesPerSource, 1);
});

test("parseConfig rejects prefixes that escape documents/", () => {
  assert.throws(
    () =>
      parseConfig(
        valid({
          sources: [
            {
              prefix: "documents/../knowledge/",
              class: "policy",
              priority: 10,
              allowExtensions: ["md"],
            },
          ],
        }),
      ),
    /prefix|escape|documents/i,
  );
});

test("parseConfig requires a trailing slash on source prefixes", () => {
  assert.throws(
    () =>
      parseConfig(
        valid({
          sources: [
            {
              prefix: "documents/handbook",
              class: "policy",
              priority: 10,
              allowExtensions: ["md"],
            },
          ],
        }),
      ),
    /slash|prefix/i,
  );
});

test("parseConfig requires teamId but no longer binds config to one node", () => {
  assert.throws(() => parseConfig(valid({ teamId: "" })), /teamId/i);
  const cfg = parseConfig(valid({ maintainerNodeId: undefined }));
  assert.equal("maintainerNodeId" in cfg, false);
});
