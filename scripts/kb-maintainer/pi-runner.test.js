"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWikiRepo, commitAll } = require("./git-store");
const {
  ALLOWED_PI_TOOLS,
  EXCLUDED_PI_TOOLS,
  piSessionPolicy,
  compile,
  parseCompilerModel,
  compilerNeedsTeamGateway,
  resolveRuntimeModel,
} = require("./pi-runner");

function makeWork() {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pi-"));
  const wikiRoot = path.join(workRoot, "wiki");
  ensureWikiRepo(wikiRoot);
  return { workRoot, wikiRoot };
}

test("Pi tool allowlist is wiki read/write/edit/find and never bash", () => {
  assert.deepEqual([...ALLOWED_PI_TOOLS].sort(), ["edit", "find", "read", "write"]);
  assert.ok(!ALLOWED_PI_TOOLS.includes("bash"));
  assert.deepEqual([...EXCLUDED_PI_TOOLS].sort(), ["bash", "grep", "ls"]);
  assert.deepEqual(piSessionPolicy(), {
    tools: ["read", "write", "edit", "find"],
    excludeTools: ["bash", "grep", "ls"],
  });
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

test("compile reports the model error instead of an empty page list", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-model-error-"));
  const wikiRoot = path.join(root, "wiki");
  fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
  fs.writeFileSync(path.join(wikiRoot, "index.md"), "# LLM Wiki\n");
  await assert.rejects(
    () =>
      compile({
        workRoot: root,
        action: "add",
        sourcePath: "documents/handbook/leave.md",
        sourceSha256: "ab".repeat(32),
        rawMarkdown: "# 请假\n",
        createSession: async () => ({
          prompt: async () => {},
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "429 Too Many Requests",
            },
          ],
        }),
      }),
    /Compiler model failed: 429 Too Many Requests/,
  );
});

test("compile writes wiki files from the reply and ignores paths outside the wiki", async () => {
  const { workRoot, wikiRoot } = makeWork();
  const compiled = await compile({
    workRoot,
    action: "add",
    sourcePath: "documents/samples/notice.md",
    sourceSha256: "ab".repeat(32),
    rawMarkdown: "明天放假",
    createSession: async () => ({
      messages: [],
      async prompt() {
        this.messages.push({
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: [
                "<<<WIKI_FILE pages/notice.md>>>",
                "# 放假",
                "明天放假。",
                "<<<END_WIKI_FILE>>>",
                "<<<WIKI_FILE /Users/lingling/secret.md>>>",
                "nope",
                "<<<END_WIKI_FILE>>>",
                "<<<WIKI_FILE ../outside.md>>>",
                "nope",
                "<<<END_WIKI_FILE>>>",
              ].join("\n"),
            },
          ],
        });
      },
    }),
  });
  assert.deepEqual(compiled.affectedPages, ["pages/notice.md"]);
  assert.match(fs.readFileSync(path.join(wikiRoot, "pages", "notice.md"), "utf8"), /明天放假/);
  assert.equal(fs.existsSync(path.join(wikiRoot, "..", "outside.md")), false);
});

test("resolveRuntimeModel loads a catalog model that is not in the short list", async () => {
  let lookups = 0;
  const model = { id: "deepseek-v4-flash-vision-exp", input: ["text", "image"] };
  const runtime = {
    getModel(provider, id) {
      lookups += 1;
      if (lookups === 1) return undefined;
      assert.equal(provider, "opencode-go");
      assert.equal(id, model.id);
      return model;
    },
    async refresh(options) {
      assert.equal(options.allowNetwork, false);
      assert.deepEqual(options.providers, ["opencode-go"]);
    },
  };
  assert.equal(
    await resolveRuntimeModel(runtime, "opencode-go", "deepseek-v4-flash-vision-exp"),
    model,
  );
  assert.equal(lookups, 2);
});

test("a device compiler model does not require the team gateway", () => {
  assert.deepEqual(parseCompilerModel("anthropic/claude-sonnet"), {
    provider: "anthropic",
    modelId: "claude-sonnet",
    source: "device",
  });
  assert.equal(compilerNeedsTeamGateway("anthropic/claude-sonnet"), false);
  assert.deepEqual(parseCompilerModel("glm-4.6"), {
    provider: "team",
    modelId: "glm-4.6",
    source: "team",
  });
  assert.equal(compilerNeedsTeamGateway("team/glm-4.6"), true);
});

test("compile fails closed when the local Agent is not running", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { workRoot } = makeWork();
  const previous = process.env.AMUXD_HOME;
  process.env.AMUXD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kb-no-agent-"));
  try {
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
      /local Agent is not running/,
    );
  } finally {
    if (previous === undefined) delete process.env.AMUXD_HOME;
    else process.env.AMUXD_HOME = previous;
  }
});
