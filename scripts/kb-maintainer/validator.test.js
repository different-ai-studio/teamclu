"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateSourceDiff } = require("./validator");

const SHA = "ab".repeat(32);

function pageMarkdown(overrides = {}) {
  const sources = overrides.sources || [
    { path: "documents/handbook/leave.md", sha256: SHA, locators: ["heading=请假"] },
  ];
  return `---
type: ${overrides.type || "policy"}
summary: ${overrides.summary || "请假规则。"}
managed_by: llm-wiki
schema_version: 1
sources:
  - path: ${sources[0].path}
    sha256: ${sources[0].sha256}
    locators: ["${sources[0].locators[0]}"]
updated: 2026-09-20
---

${overrides.body || "员工请假需提前申请。"}
`;
}

function makeWiki(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-val-"));
  const wiki = path.join(root, "wiki");
  const raw = path.join(root, "raw");
  fs.mkdirSync(path.join(wiki, "pages"), { recursive: true });
  fs.mkdirSync(path.join(raw, "documents", "handbook"), { recursive: true });
  fs.writeFileSync(
    path.join(raw, "documents", "handbook", "leave.md.md"),
    `---
source_path: documents/handbook/leave.md
source_sha256: ${SHA}
---

<!-- source-locator: heading=请假 -->
# 请假
员工请假需提前申请。
`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(wiki, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, wiki, raw };
}

const baseOpts = {
  changedRelPaths: ["pages/leave.md", "index.md"],
  currentSource: {
    path: "documents/handbook/leave.md",
    sourceSha256: SHA,
    rawRelPath: "documents/handbook/leave.md.md",
  },
  config: { limits: { maxPagesChangedPerSource: 15, maxIndexChars: 8000, maxSourceSummaryChars: 4000, maxSourceSummaryPagesPerSource: 1 } },
};

test("validateSourceDiff accepts a well-formed page and index", () => {
  const fx = makeWiki({
    "pages/leave.md": pageMarkdown(),
    "index.md": `# LLM Wiki

## 制度
- [[pages/leave|请假规则]] — 请假规则。
`,
  });
  const result = validateSourceDiff({ ...baseOpts, workRoot: fx.root, wikiRoot: fx.wiki, rawRoot: fx.raw });
  assert.equal(result.ok, true, result.errors && result.errors.join("; "));
});

test("validateSourceDiff rejects files outside wiki pages and index", () => {
  const fx = makeWiki({
    "pages/leave.md": pageMarkdown(),
    "index.md": "# LLM Wiki\n",
    "secret.md": "nope",
  });
  const result = validateSourceDiff({
    ...baseOpts,
    workRoot: fx.root,
    wikiRoot: fx.wiki,
    rawRoot: fx.raw,
    changedRelPaths: ["pages/leave.md", "index.md", "secret.md"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /wiki\/pages|index/i);
});

test("validateSourceDiff rejects missing locators, PII, and dead wiki links", () => {
  const fx = makeWiki({
    "pages/leave.md": pageMarkdown({
      sources: [{ path: "documents/handbook/leave.md", sha256: SHA, locators: ["heading=不存在"] }],
      body: "身份证 110101199001011234 见 [[pages/missing|缺失]]",
    }),
    "index.md": `# LLM Wiki\n\n## 制度\n- [[pages/leave|请假规则]] — 请假规则。\n`,
  });
  const result = validateSourceDiff({ ...baseOpts, workRoot: fx.root, wikiRoot: fx.wiki, rawRoot: fx.raw });
  assert.equal(result.ok, false);
  const text = result.errors.join("\n");
  assert.match(text, /locator/i);
  assert.match(text, /PII|身份证|sensitive/i);
  assert.match(text, /dead|missing|link/i);
});
