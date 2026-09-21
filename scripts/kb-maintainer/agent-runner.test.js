"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compile } = require("./agent-runner");
const fake = require("./fake-runner");

test("agent-runner keeps the fake runner for tests and fixtures", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fake-"));
  const result = await compile({
    runner: "fake",
    workRoot,
    action: "add",
    sourcePath: "documents/handbook/leave.md",
    sourceSha256: "ab".repeat(32),
    rawMarkdown: "---\n---\n# 请假\n\n员工请假需提前申请。\n",
    locators: ["heading=请假"],
    pageType: "policy",
  });
  assert.ok(Array.isArray(result.affectedPages));
  assert.ok(result.affectedPages.some((rel) => rel.startsWith("pages/")));
  assert.equal(typeof fake.compile, "function");
});

test("agent-runner sends runner=pi to the Pi compiler", async () => {
  const { compile: agentCompile } = require("./agent-runner");
  await assert.rejects(
    () =>
      agentCompile({
        runner: "pi",
        workRoot: require("node:fs").mkdtempSync(
          require("node:path").join(require("node:os").tmpdir(), "kb-agent-pi-"),
        ),
        action: "add",
        sourcePath: "documents/handbook/leave.md",
        sourceSha256: "ab".repeat(32),
        rawMarkdown: "# 请假\n",
        locators: [],
      }),
    /Team AI gateway/i,
  );
});
