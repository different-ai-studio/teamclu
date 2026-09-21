"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWikiRepo, commitAll } = require("./git-store");
const { ALLOWED_PI_TOOLS, compile } = require("./pi-runner");

function makeWork() {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pi-"));
  const wikiRoot = path.join(workRoot, "wiki");
  ensureWikiRepo(wikiRoot);
  return { workRoot, wikiRoot };
}

test("Pi tool allowlist is wiki read/write/edit/find and never bash", () => {
  assert.deepEqual([...ALLOWED_PI_TOOLS].sort(), ["edit", "find", "read", "write"]);
  assert.ok(!ALLOWED_PI_TOOLS.includes("bash"));
});

test("compile with an injected session records wiki pages from git, not the model report", async () => {
  const { workRoot, wikiRoot } = makeWork();
  let receivedPrompt = "";
  const compiled = await compile({
    workRoot,
    action: "add",
    sourcePath: "documents/handbook/leave.md",
    sourceSha256: "ab".repeat(32),
    rawMarkdown: "# 请假\n\n员工请假需提前申请。",
    locators: ["heading=请假"],
    pageType: "policy",
    schemaMarkdown: "# rules",
    indexMarkdown: "# LLM Wiki\n",
    createSession: async () => ({
      prompt: async (text) => {
        receivedPrompt = text;
        fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
        fs.writeFileSync(
          path.join(wikiRoot, "pages", "请假.md"),
          "---\ntype: policy\nsummary: 请假。\nmanaged_by: llm-wiki\nschema_version: 1\nsources:\n  - path: documents/handbook/leave.md\n    sha256: aabb\n    locators: [\"heading=请假\"]\nupdated: 2026-09-21\n---\n\n# 请假\n\n员工请假需提前申请。\n",
        );
        fs.writeFileSync(
          wikiRoot + "/index.md",
          "# LLM Wiki\n\n## 制度\n- [[pages/请假|请假]] — 请假。\n",
        );
      },
      waitForIdle: async () => {},
    }),
  });
  assert.match(receivedPrompt, /<source>/);
  assert.deepEqual(compiled.affectedPages, ["index.md", "pages/请假.md"]);
});

test("Pi compile fails closed when the team gateway is missing", async () => {
  const { workRoot } = makeWork();
  delete process.env.TEAMCLU_TEAM_PROVIDER;
  delete process.env.tc_gateway_token;
  await assert.rejects(
    () =>
      compile({
        workRoot,
        action: "add",
        sourcePath: "documents/handbook/leave.md",
        sourceSha256: "ab".repeat(32),
        rawMarkdown: "# 请假\n",
        locators: [],
        schemaMarkdown: "",
        indexMarkdown: "",
      }),
    /Team AI gateway/i,
  );
});
