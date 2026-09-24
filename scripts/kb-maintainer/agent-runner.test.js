"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compile } = require("./agent-runner");
const fake = require("./fake-runner");

test("agent-runner keeps the fake runner for tests and fixtures", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { rawRelativePath } = require("./extract-text");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fake-"));
  const rawMarkdown = "# 请假\n\n员工请假需提前申请。\n";
  const rawAbs = path.join(workRoot, "raw", rawRelativePath("documents/handbook/leave.md"));
  fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
  fs.writeFileSync(rawAbs, rawMarkdown);
  const result = await compile({
    runner: "fake",
    workRoot,
    action: "add",
    sourcePath: "documents/handbook/leave.md",
    sourceSha256: "ab".repeat(32),
    rawMarkdown,
    locators: ["heading=请假"],
    pageType: "policy",
  });
  assert.ok(Array.isArray(result.affectedPages));
  assert.ok(result.affectedPages.some((rel) => rel.startsWith("pages/")));
  assert.equal(typeof fake.compile, "function");
});

test("agent-runner sends runner=pi to the local Agent", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { compile: agentCompile } = require("./agent-runner");
  const previous = process.env.AMUXD_HOME;
  process.env.AMUXD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kb-no-agent-"));
  try {
    await assert.rejects(
      () =>
        agentCompile({
          runner: "pi",
          workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "kb-agent-pi-")),
          action: "add",
          sourcePath: "documents/handbook/leave.md",
          sourceSha256: "ab".repeat(32),
          rawMarkdown: "# 请假\n",
          locators: [],
        }),
      /local Agent is not running/,
    );
  } finally {
    if (previous === undefined) delete process.env.AMUXD_HOME;
    else process.env.AMUXD_HOME = previous;
  }
});
