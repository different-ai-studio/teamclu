"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWikiRepo, commitAll, headCommit } = require("./git-store");
const { serializeFrontmatter } = require("./frontmatter");
const { repairWiki, limitCompileDiff } = require("./repair");
const { lintBatch } = require("./lint");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("repairWiki drops dead links, secrets, and stale hashes before lint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-repair-"));
  const wikiRoot = path.join(root, "wiki");
  ensureWikiRepo(wikiRoot);
  const sha = "ab".repeat(32);
  write(
    path.join(wikiRoot, "pages", "leave.md"),
    serializeFrontmatter(
      {
        type: "policy",
        summary: "身份证 110101199001011234",
        managed_by: "llm-wiki",
        schema_version: 1,
        sources: [
          {
            path: "documents/handbook/leave.md",
            sha256: "old",
            locators: ["heading=请假"],
          },
        ],
        updated: "2026-09-20",
      },
      "见 [[pages/missing|缺失]]，路径 /Users/alice/secret，电话 13800138000。\n",
    ),
  );
  commitAll(wikiRoot, "seed");
  const state = {
    sources: {
      "documents/handbook/leave.md": { status: "imported", sourceSha256: sha },
    },
  };
  const repaired = repairWiki(wikiRoot, { state, maxBytes: 8000 });
  assert.equal(repaired.changed, true);
  const page = fs.readFileSync(path.join(wikiRoot, "pages", "leave.md"), "utf8");
  assert.doesNotMatch(page, /110101199001011234/);
  assert.doesNotMatch(page, /13800138000/);
  assert.doesNotMatch(page, /\/Users\/alice/);
  assert.doesNotMatch(page, /\[\[pages\/missing/);
  assert.match(page, /缺失/);
  assert.match(page, new RegExp(sha));
  const lint = lintBatch({
    wikiRoot,
    state,
    config: { limits: { maxIndexChars: 8000, freshnessDays: 180 } },
  });
  assert.equal(lint.ok, true, JSON.stringify(lint));
});

test("limitCompileDiff drops a file outside the wiki and keeps the compiled page", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-repair-"));
  const wikiRoot = path.join(root, "wiki");
  ensureWikiRepo(wikiRoot);
  const before = headCommit(wikiRoot);
  write(path.join(wikiRoot, "notes.txt"), "nope\n");
  write(
    path.join(wikiRoot, "pages", "keep.md"),
    serializeFrontmatter(
      {
        type: "policy",
        summary: "保留",
        managed_by: "llm-wiki",
        schema_version: 1,
        sources: [
          { path: "documents/handbook/a.md", sha256: "ab".repeat(32), locators: [] },
        ],
        updated: "2026-09-20",
      },
      "正文。\n",
    ),
  );
  limitCompileDiff(wikiRoot, before, "documents/handbook/a.md", 15);
  assert.equal(fs.existsSync(path.join(wikiRoot, "notes.txt")), false);
  assert.equal(fs.existsSync(path.join(wikiRoot, "pages", "keep.md")), true);
});
