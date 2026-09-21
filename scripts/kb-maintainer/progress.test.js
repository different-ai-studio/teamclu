"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PROGRESS_PREFIX, writeProgress, parseProgressLine } = require("./progress");

test("progress lines round-trip through stderr prefix", () => {
  const lines = [];
  writeProgress({ stage: "ingest", path: "documents/a.md", current: 1, total: 2 }, (line) =>
    lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(PROGRESS_PREFIX));
  assert.deepEqual(parseProgressLine(lines[0]), {
    stage: "ingest",
    path: "documents/a.md",
    current: 1,
    total: 2,
  });
  assert.equal(parseProgressLine("not progress"), null);
});
