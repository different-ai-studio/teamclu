"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWikiRepo, commitAll, headCommit } = require("./git-store");
const { loadState, saveState } = require("./ingest");
const { buildPublishPlan, publishWiki } = require("./publish");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeWiki() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pub-"));
  const wikiRoot = path.join(root, "work", "wiki");
  const knowledgeRoot = path.join(root, "knowledge");
  const statePath = path.join(root, "work", "state", "state.json");
  ensureWikiRepo(wikiRoot);
  write(path.join(wikiRoot, "pages", "leave.md"), "# 请假\n\n提前申请。\n");
  write(path.join(wikiRoot, "index.md"), "# LLM Wiki\n\n- [[pages/leave|请假]] — 提前申请。\n");
  const toCommit = commitAll(wikiRoot, "ingest(add): documents/handbook/leave.md@abc");
  saveState(statePath, { schemaVersion: 1, sources: {}, publishedCommit: null });
  return { root, wikiRoot, knowledgeRoot, statePath, toCommit };
}

test("buildPublishPlan lists creates from an unpublished HEAD", () => {
  const fx = makeWiki();
  const plan = buildPublishPlan({ wikiRoot: fx.wikiRoot, fromCommit: null, toCommit: fx.toCommit });
  assert.deepEqual(plan.create.sort(), ["index.md", "pages/leave.md"]);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.targetTreeHash.length, 64);
  assert.equal(plan.toCommit, fx.toCommit);
});

test("publishWiki refuses unexplained pages without a published baseline", async () => {
  const fx = makeWiki();
  write(path.join(fx.knowledgeRoot, "wiki", "pages", "请假.md"), "# stale\n");
  write(path.join(fx.knowledgeRoot, "wiki", "index.md"), "# stale index\n");
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
      }),
    /unexplained/,
  );
});

test("publishWiki rejects path escape into the vault", async () => {
  const fx = makeWiki();
  write(path.join(fx.wikiRoot, "pages", "..-escape.md"), "nope");
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        planOverride: {
          fromCommit: null,
          toCommit: fx.toCommit,
          create: ["pages/../secret.md"],
          update: [],
          delete: [],
          targetTreeHash: "x",
        },
      }),
    /escape|illegal/i,
  );
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "secret.md")), false);
});

test("publishWiki replays an interrupted publish instead of leaving a torn tree", async () => {
  const fx = makeWiki();
  let crashes = 0;
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
        _crashAfter: "pages",
      }),
    /injected crash/,
  );
  crashes += 1;
  const marker = path.join(fx.root, "work", "state", "publish-incomplete.json");
  assert.equal(fs.existsSync(marker), true);
  const replayed = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  assert.equal(replayed.ok, true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(loadState(fx.statePath).publishedCommit, fx.toCommit);
  assert.equal(crashes, 1);
});

test("publishWiki stops on unexplained vault edits", async () => {
  const fx = makeWiki();
  await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  fs.appendFileSync(path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md"), "\nhacked\n");
  write(path.join(fx.wikiRoot, "pages", "leave.md"), "# 请假\n\n更新。\n");
  commitAll(fx.wikiRoot, "ingest(update): documents/handbook/leave.md@def");
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
      }),
    /external|modified|conflict/i,
  );
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
        forceReplay: true,
      }),
    /unexplained/,
  );
});

test("publishWiki accepts a vault that already matches the target when the baseline commit is older", async () => {
  const fx = makeWiki();
  await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  const baseline = loadState(fx.statePath).publishedCommit;
  write(path.join(fx.wikiRoot, "pages", "extra.md"), "# 补充\n");
  commitAll(fx.wikiRoot, "ingest(add): documents/handbook/extra.md@abc");
  await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  const state = loadState(fx.statePath);
  state.publishedCommit = baseline;
  saveState(fx.statePath, state);
  const again = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  assert.equal(again.ok, true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "extra.md")), true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md")), true);
});

test("publishWiki cloud recovery accepts a vault containing only base and target bytes", async () => {
  const fx = makeWiki();
  await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  write(path.join(fx.wikiRoot, "pages", "leave.md"), "# 请假\n\n更新。\n");
  commitAll(fx.wikiRoot, "ingest(update): documents/handbook/leave.md@def");
  write(
    path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md"),
    "# 请假\n\n更新。\n",
  );
  const recovered = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
    forceReplay: true,
  });
  assert.equal(recovered.ok, true);
});

test("publishWiki keeps vault pages whose sources are still on disk", async () => {
  const fx = makeWiki();
  const documents = path.join(fx.root, "documents", "features");
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(path.join(documents, "shell.md"), "# shell\n");
  write(
    path.join(fx.wikiRoot, "pages", "leave.md"),
    `---
type: process
summary: 请假
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/handbook/leave.md
    sha256: ${"11".repeat(32)}
    locators: ["heading=请假"]
updated: 2026-09-22
---

# 请假
`,
  );
  const compiled = commitAll(fx.wikiRoot, "ingest(add): documents/handbook/leave.md@111111111111");
  const old = `---
type: process
summary: 三栏
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/features/shell.md
    sha256: ${"ab".repeat(32)}
    locators: ["heading=三栏"]
updated: 2026-09-22
---

# 三栏 Shell
`;
  write(path.join(fx.knowledgeRoot, "wiki", "pages", "3col-shell.md"), old);
  write(path.join(fx.knowledgeRoot, "wiki", "index.md"), "# LLM Wiki\n\n- [[pages/3col-shell|三栏 Shell]] — 三栏\n");
  const { treeHashFromCommit } = require("./publish");
  const result = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    documentsRoot: path.join(fx.root, "documents"),
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
    forceReplay: true,
    expectedTargetCommit: compiled,
    expectedTargetTreeHash: treeHashFromCommit(fx.wikiRoot, compiled),
    expectedBaseTreeHash: null,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "3col-shell.md")), true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md")), true);
  const index = fs.readFileSync(path.join(fx.knowledgeRoot, "wiki", "index.md"), "utf8");
  assert.match(index, /3col-shell/);
  assert.match(index, /leave/);
  assert.equal(loadState(fx.statePath).publishedCommit.length > 0, true);
});

test("publishWiki keeps a vault page whose source is listed but not downloaded", async () => {
  const fx = makeWiki();
  write(
    path.join(fx.wikiRoot, "pages", "leave.md"),
    `---
type: process
summary: 请假
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/handbook/leave.md
    sha256: ${"11".repeat(32)}
    locators: ["heading=请假"]
updated: 2026-09-22
---

# 请假
`,
  );
  commitAll(fx.wikiRoot, "ingest(add): documents/handbook/leave.md@111111111111");
  fs.mkdirSync(path.join(fx.root, "documents", "handbook"), { recursive: true });
  fs.writeFileSync(path.join(fx.root, "documents", "handbook", "leave.md"), "# 请假\n");
  const listed = `---
type: process
summary: 三栏
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/features/shell.md
    sha256: ${"ab".repeat(32)}
    locators: ["heading=三栏"]
updated: 2026-09-22
---

# 三栏 Shell
`;
  write(path.join(fx.knowledgeRoot, "wiki", "pages", "3col-shell.md"), listed);
  write(path.join(fx.knowledgeRoot, "wiki", "index.md"), "# LLM Wiki\n");
  const result = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    documentsRoot: path.join(fx.root, "documents"),
    known: [{ path: "documents/features/shell.md", size: 20 }],
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "3col-shell.md")), true);
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md")), true);
});

test("publishWiki still refuses a vault page whose source file is gone", async () => {
  const fx = makeWiki();
  const old = `---
type: process
summary: 已删除
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/features/gone.md
    sha256: ${"cd".repeat(32)}
    locators: ["heading=gone"]
updated: 2026-09-22
---

# 已删除
`;
  write(path.join(fx.knowledgeRoot, "wiki", "pages", "gone.md"), old);
  write(path.join(fx.knowledgeRoot, "wiki", "index.md"), "# stale\n");
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        documentsRoot: path.join(fx.root, "documents"),
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
        forceReplay: true,
      }),
    /unexplained/,
  );
  assert.equal(fs.existsSync(path.join(fx.knowledgeRoot, "wiki", "pages", "leave.md")), false);
});

test("publishWiki refuses a local target that differs from the cloud checkpoint", async () => {
  const fx = makeWiki();
  await assert.rejects(
    () =>
      publishWiki({
        wikiRoot: fx.wikiRoot,
        knowledgeRoot: fx.knowledgeRoot,
        statePath: fx.statePath,
        workRoot: path.join(fx.root, "work"),
        syncTeam: () => ({ ok: true }),
        expectedTargetCommit: "f".repeat(40),
        expectedTargetTreeHash: "e".repeat(64),
        expectedBaseTreeHash: null,
      }),
    /does not match the cloud checkpoint/,
  );
});

test("publishWiki records sync_pending when bulk add is blocked", async () => {
  const fx = makeWiki();
  const result = await publishWiki({
    wikiRoot: fx.wikiRoot,
    knowledgeRoot: fx.knowledgeRoot,
    statePath: fx.statePath,
    workRoot: path.join(fx.root, "work"),
    syncTeam: () => ({ ok: false, blocked_new_files: 80 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.syncStatus, "published_local_sync_pending");
  assert.equal(loadState(fx.statePath).syncStatus, "published_local_sync_pending");
  assert.equal(loadState(fx.statePath).publishedCommit, fx.toCommit);
});
