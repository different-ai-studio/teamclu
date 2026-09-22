"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serializeFrontmatter } = require("./frontmatter");
const { lintBatch } = require("./lint");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function page({ type = "policy", title, summary, sources, body, updated = "2026-09-20" }) {
  return serializeFrontmatter(
    {
      type,
      summary,
      managed_by: "llm-wiki",
      schema_version: 1,
      sources,
      updated,
    },
    `# ${title}\n\n${body}\n`,
  );
}

test("lintBatch blocks dead links and stale source hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lint-"));
  const wikiRoot = path.join(root, "wiki");
  const leave = page({
    title: "请假",
    summary: "请假需提前申请。",
    sources: [{ path: "documents/handbook/leave.md", sha256: "aa".repeat(32), locators: ["heading=请假"] }],
    body: "见 [[pages/missing|不存在]]。",
  });
  write(path.join(wikiRoot, "pages", "请假.md"), leave);
  write(path.join(wikiRoot, "index.md"), "# LLM Wiki\n\n## 制度\n- [[pages/请假|请假]] — 请假需提前申请。\n");
  const report = lintBatch({
    wikiRoot,
    state: {
      schemaVersion: 1,
      sources: {
        "documents/handbook/leave.md": {
          sourceSha256: "bb".repeat(32),
          status: "imported",
          affectedPages: ["pages/请假.md"],
        },
      },
    },
    config: { limits: { maxIndexChars: 8000, freshnessDays: 180 } },
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => /dead wiki link/.test(item)));
  assert.ok(report.errors.some((item) => /source sha256 mismatch/.test(item)));
});

test("lintBatch warnings do not block publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lintw-"));
  const wikiRoot = path.join(root, "wiki");
  const sha = "cc".repeat(32);
  const source = { path: "documents/handbook/leave.md", sha256: sha, locators: ["heading=请假"] };
  write(
    path.join(wikiRoot, "pages", "请假.md"),
    page({
      title: "请假",
      summary: "同一摘要。",
      sources: [source],
      body: "## 提前申请\n\n需提前三天。",
      updated: "2020-01-01",
    }),
  );
  write(
    path.join(wikiRoot, "pages", "销假.md"),
    page({
      title: "销假",
      summary: "同一摘要。",
      sources: [source],
      body: "## 提前申请\n\n销假当天完成。",
    }),
  );
  write(
    path.join(wikiRoot, "index.md"),
    "# LLM Wiki\n\n## 制度\n- [[pages/请假|请假]] — 同一摘要。\n- [[pages/销假|销假]] — 同一摘要。\n",
  );
  const report = lintBatch({
    wikiRoot,
    state: {
      schemaVersion: 1,
      sources: {
        "documents/handbook/leave.md": {
          sourceSha256: sha,
          status: "imported",
          affectedPages: ["pages/请假.md", "pages/销假.md"],
        },
      },
    },
    config: { limits: { maxIndexChars: 8000, freshnessDays: 30 } },
  });
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((item) => /duplicate summary/.test(item)));
  assert.ok(report.warnings.some((item) => /shared heading/.test(item)));
  assert.ok(report.warnings.some((item) => /stale page/.test(item)));
});
