"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ingestBatch } = require("./ingest");
const { prepare } = require("./desktop-runner");
const { dryRun } = require("./dry-run");
const { serializeFrontmatter } = require("./frontmatter");

const SOURCE = "documents/营运部/整车成本.csv";

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function csvText(rows) {
  const lines = ["日期,车牌,司机,成本,备注"];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`2026-10-${String((index % 28) + 1).padStart(2, "0")},粤A${10000 + index},司机${index % 40},${(index * 7) % 900}.5,线路${index % 9}`);
  }
  return `${lines.join("\n")}\n`;
}

function makeHarness(rows = 3000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-large-"));
  const fx = {
    root,
    documentsRoot: path.join(root, "documents"),
    knowledgeRoot: path.join(root, "knowledge"),
    workRoot: path.join(root, "work"),
    configPath: path.join(root, "config.json"),
  };
  fx.statePath = path.join(fx.workRoot, "state", "state.json");
  write(path.join(fx.knowledgeRoot, "_schema.md"), "# rules\n");
  write(
    fx.configPath,
    JSON.stringify({
      schemaVersion: 1,
      teamId: "11111111-1111-4111-8111-111111111111",
      sources: [{ prefix: "documents/营运部/", class: "process", priority: 1, allowExtensions: ["csv"] }],
      deny: { pathPatterns: [] },
    }),
  );
  write(fx.statePath, JSON.stringify({ schemaVersion: 1, sources: {} }));
  write(path.join(fx.documentsRoot, "营运部", "整车成本.csv"), csvText(rows));
  return fx;
}

function base(fx) {
  return {
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    workRoot: fx.workRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: [],
  };
}

/** A model that writes one page per part and records each prompt it saw. */
function scriptedModel({ failAtPart } = {}) {
  const prompts = [];
  const createSession = async (ctx) => ({
    prompt: async (prompt) => {
      prompts.push({ part: ctx.part, parts: ctx.parts, locators: ctx.locators, prompt });
      if (failAtPart !== undefined && ctx.part === failAtPart) throw new Error("Compiler model failed: 429 Too Many Requests");
      const name = ctx.parts ? `整车成本-第${ctx.part}段` : "整车成本-表结构";
      write(
        path.join(ctx.workRoot, "wiki", "pages", `${name}.md`),
        serializeFrontmatter(
          {
            type: "process",
            summary: `${name}摘要。`,
            managed_by: "llm-wiki",
            schema_version: 1,
            sources: [{ path: SOURCE, sha256: ctx.sourceSha256, locators: ctx.locators }],
            updated: "2026-11-18",
          },
          `# ${name}\n\n成本按车辆和司机归集。\n`,
        ),
      );
    },
  });
  return { prompts, createSession };
}

function commitSubjects(fx) {
  return execFileSync("git", ["log", "--format=%s"], { cwd: path.join(fx.workRoot, "wiki"), encoding: "utf8" })
    .trim()
    .split("\n");
}

test("an over-limit table with no choice fails with its length instead of reaching the model", async () => {
  const fx = makeHarness();
  const model = scriptedModel();
  const result = await ingestBatch({ ...base(fx), runner: "pi", createSession: model.createSession });
  assert.equal(model.prompts.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /^too_large chars=\d+ limit=50000$/);
});

test("profile compiles the column summary once, not the rows", async () => {
  const fx = makeHarness();
  const model = scriptedModel();
  const result = await ingestBatch({
    ...base(fx),
    runner: "pi",
    createSession: model.createSession,
    largeSourceChoices: { [SOURCE]: "profile" },
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(model.prompts.length, 1);
  assert.match(model.prompts[0].prompt, /共 3000 行数据、5 列/);
  assert.doesNotMatch(model.prompts[0].prompt, /粤A12999/);
  assert.doesNotMatch(model.prompts[0].prompt, /Source part:/);
  const raw = fs.readFileSync(path.join(fx.workRoot, "raw", `${SOURCE}.md`), "utf8");
  assert.match(raw, /large_source_mode: profile/);
  const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8")).sources[SOURCE];
  assert.equal(state.status, "imported");
  assert.equal(state.largeSourceMode, "profile");
  assert.ok(state.sourceSha256);
});

test("segment compiles every part in order, shows later parts the pages already written, and commits each part", async () => {
  const fx = makeHarness();
  const model = scriptedModel();
  const progress = [];
  const result = await ingestBatch({
    ...base(fx),
    runner: "pi",
    createSession: model.createSession,
    largeSourceChoices: { [SOURCE]: "segment" },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  const parts = model.prompts[0].parts;
  assert.ok(parts > 1);
  assert.deepEqual(model.prompts.map((item) => item.part), Array.from({ length: parts }, (_, index) => index + 1));
  assert.match(model.prompts[0].prompt, /Source part: 1 of /);
  assert.doesNotMatch(model.prompts[0].prompt, /<current-page/);
  assert.match(model.prompts[1].prompt, /<current-page path="pages\/整车成本-第1段\.md">/);
  assert.match(model.prompts[1].prompt, /\| 日期 \| 车牌 \| 司机 \| 成本 \| 备注 \|/);
  assert.deepEqual(
    progress.filter((event) => event.part).map((event) => [event.part, event.parts, event.current, event.total]),
    Array.from({ length: parts }, (_, index) => [index + 1, parts, 1, 1]),
  );
  const subjects = commitSubjects(fx);
  assert.equal(subjects.filter((subject) => /\(part \d+\/\d+\)$/.test(subject)).length, parts);
  const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8")).sources[SOURCE];
  assert.equal(state.largeSourceMode, "segment");
  assert.equal(state.parts, parts);
  assert.equal(state.affectedPages.filter((rel) => rel.startsWith("pages/")).length, parts);
});

test("a failed later part keeps the earlier parts and sends the source back for the next run", async () => {
  const fx = makeHarness();
  const model = scriptedModel({ failAtPart: 2 });
  const result = await ingestBatch({
    ...base(fx),
    runner: "pi",
    createSession: model.createSession,
    largeSourceChoices: { [SOURCE]: "segment" },
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /^segment 2\/\d+ kept=1: Compiler model failed: 429/);
  assert.equal(fs.existsSync(path.join(fx.workRoot, "wiki", "pages", "整车成本-第1段.md")), true);
  assert.equal(fs.existsSync(path.join(fx.workRoot, "wiki", "pages", "整车成本-第2段.md")), false);
  const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8")).sources[SOURCE];
  assert.equal(state.status, "imported");
  assert.equal(state.sourceSha256, null);
  const next = dryRun(base(fx));
  assert.deepEqual(next.plan.update.map((item) => item.path), [SOURCE]);
});

test("a failed first part rolls the whole source back", async () => {
  const fx = makeHarness();
  const model = scriptedModel({ failAtPart: 1 });
  const result = await ingestBatch({
    ...base(fx),
    runner: "pi",
    createSession: model.createSession,
    largeSourceChoices: { [SOURCE]: "segment" },
  });
  assert.match(result.failures[0].error, /^Compiler model failed: 429/);
  assert.equal(model.prompts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(fx.statePath, "utf8")).sources[SOURCE], undefined);
});

test("prepare stops before compiling to ask about large files, then compiles with the answer", async () => {
  const fx = makeHarness();
  write(path.join(fx.documentsRoot, "营运部", "small.csv"), csvText(3));
  const input = {
    ...base(fx),
    runId: "run-large",
    compilerModel: "default",
    runner: "fake",
  };
  const asked = await prepare(input, {});
  assert.equal(asked.needsLargeSourceDecision, true);
  assert.equal(asked.canPublish, false);
  assert.equal(asked.added, 0);
  assert.equal(asked.sourceCount, 2);
  assert.equal(asked.largeSources.length, 1);
  assert.equal(asked.largeSources[0].path, SOURCE);
  assert.deepEqual(asked.largeSources[0].options, ["profile", "segment", "skip"]);
  assert.equal(fs.existsSync(path.join(fx.workRoot, "wiki", "pages")), false);

  const invalid = await prepare({ ...input, largeSourceChoices: { [SOURCE]: "everything" } }, {});
  assert.equal(invalid.needsLargeSourceDecision, true);

  const done = await prepare({ ...input, largeSourceChoices: { [SOURCE]: "profile" } }, {});
  assert.equal(done.needsLargeSourceDecision, undefined);
  assert.equal(done.failed, 0, JSON.stringify(done.blockers));
  assert.equal(done.added, 2);
  assert.equal(done.canPublish, true);
});

test("prepare counts a large file the person chose to skip as skipped, not failed", async () => {
  const fx = makeHarness();
  write(path.join(fx.documentsRoot, "营运部", "small.csv"), csvText(3));
  const done = await prepare(
    {
      ...base(fx),
      runId: "run-skip",
      compilerModel: "default",
      runner: "fake",
      largeSourceChoices: { [SOURCE]: "skip" },
    },
    {},
  );
  assert.equal(done.failed, 0);
  assert.equal(done.added, 1);
  assert.equal(done.canPublish, true);
  assert.deepEqual(done.blockers, [
    `${SOURCE}: This source was skipped this run and will be compiled again next time.`,
  ]);
});
