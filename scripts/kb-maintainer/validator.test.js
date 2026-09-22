"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateSourceDiff, normalizeWikiLinks, dropDeadWikiLinks, rebuildIndex } = require("./validator");

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

test("validateSourceDiff only applies copy-ratio to pages that cite the current source", () => {
  const longRaw = `${"原料内容。".repeat(400)}\n`;
  const fx = makeWiki({
    "pages/leave.md": pageMarkdown({
      body: "员工请假需提前申请。",
    }),
    "pages/unrelated.md": pageMarkdown({
      sources: [
        {
          path: "documents/handbook/other.md",
          sha256: "cd".repeat(32),
          locators: ["heading=其它"],
        },
      ],
      summary: "其它。",
      body: longRaw.slice(0, Math.floor(longRaw.length * 0.95)),
    }),
    "index.md": `# LLM Wiki

## 制度
- [[pages/leave|请假规则]] — 请假规则。
- [[pages/unrelated|其它]] — 其它。
`,
  });
  fs.writeFileSync(
    path.join(fx.raw, "documents", "handbook", "leave.md.md"),
    `---\nsource_path: documents/handbook/leave.md\nsource_sha256: ${SHA}\n---\n\n<!-- source-locator: heading=请假 -->\n# 请假\n${longRaw}`,
  );
  const ok = validateSourceDiff({
    ...baseOpts,
    workRoot: fx.root,
    wikiRoot: fx.wiki,
    rawRoot: fx.raw,
    changedRelPaths: ["pages/leave.md", "index.md"],
  });
  assert.equal(ok.ok, true, ok.errors && ok.errors.join("; "));

  fs.writeFileSync(
    path.join(fx.wiki, "pages", "leave.md"),
    pageMarkdown({ body: longRaw.slice(0, Math.floor(longRaw.length * 0.95)) }),
  );
  const bad = validateSourceDiff({
    ...baseOpts,
    workRoot: fx.root,
    wikiRoot: fx.wiki,
    rawRoot: fx.raw,
    changedRelPaths: ["pages/leave.md", "index.md"],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /pages\/leave\.md: copy ratio too high/);
  assert.doesNotMatch(bad.errors.join("\n"), /unrelated/);
});

test("dropDeadWikiLinks keeps the label and removes a link whose page was never written", () => {
  const fx = makeWiki({
    "pages/knowledge-base.md": pageMarkdown({
      body: "详见 [[missing-target|还不存在的条目]] 和 [[pages/also-missing]]。",
    }),
    "index.md": "# LLM Wiki\n",
  });
  const result = dropDeadWikiLinks(fx.wiki);
  assert.equal(result.rewritten, 1);
  const text = fs.readFileSync(path.join(fx.wiki, "pages", "knowledge-base.md"), "utf8");
  assert.match(text, /还不存在的条目/);
  assert.match(text, /also-missing/);
  assert.doesNotMatch(text, /\[\[/);
});

test("normalizeWikiLinks rewrites short links onto pages/ when the target page exists", () => {
  const fx = makeWiki({
    "pages/amuxd-home-directory.md": pageMarkdown({
      body: "见 [[amuxd-device-id]] 和 [[amuxd-device-id|设备]] 以及 [[pages/amuxd-device-id]]。",
    }),
    "pages/amuxd-device-id.md": pageMarkdown({
      summary: "设备 id。",
      body: "设备身份。",
    }),
    "index.md": "# LLM Wiki\n",
  });
  const result = normalizeWikiLinks(fx.wiki);
  assert.equal(result.rewritten, 1);
  const text = fs.readFileSync(path.join(fx.wiki, "pages", "amuxd-home-directory.md"), "utf8");
  assert.match(text, /\[\[pages\/amuxd-device-id\]\]/);
  assert.match(text, /\[\[pages\/amuxd-device-id\|设备\]\]/);
  assert.doesNotMatch(text, /\[\[amuxd-device-id\]\]/);
  assert.doesNotMatch(text, /\[\[amuxd-device-id\|/);
});

function amuxdPage(overrides = {}) {
  const summaryLine =
    overrides.omitSummary
      ? ""
      : `summary: ${overrides.summary ?? "本机 amuxd 家目录。"}\n`;
  return `---
type: ${overrides.type || "process"}
${summaryLine}managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/spec-docs/amuxd-home-directory.md
    sha256: ${SHA}
    locators: ["heading=home"]
updated: 2026-09-21
---

${overrides.body || "# `~/.amuxd` 目录说明\n\n本机 Agent Daemon 的家目录。\n"}
`;
}

function makeAmuxdWiki(files) {
  const fx = makeWiki(files);
  fs.mkdirSync(path.join(fx.raw, "documents", "spec-docs"), { recursive: true });
  fs.writeFileSync(
    path.join(fx.raw, "documents", "spec-docs", "amuxd-home-directory.md.md"),
    `---
source_path: documents/spec-docs/amuxd-home-directory.md
source_sha256: ${SHA}
---

<!-- source-locator: heading=home -->
# home
`,
  );
  return fx;
}

function amuxdOpts(fx, extra = {}) {
  return {
    ...baseOpts,
    workRoot: fx.root,
    wikiRoot: fx.wiki,
    rawRoot: fx.raw,
    changedRelPaths: extra.changedRelPaths || ["pages/amuxd-home-directory.md", "index.md"],
    currentSource: {
      path: "documents/spec-docs/amuxd-home-directory.md",
      sourceSha256: SHA,
      rawRelPath: "documents/spec-docs/amuxd-home-directory.md.md",
    },
  };
}

test("rebuildIndex then validate accepts a compiler page that omitted summary", () => {
  const fx = makeAmuxdWiki({
    "pages/amuxd-home-directory.md": amuxdPage({ omitSummary: true }),
    "index.md": "# LLM Wiki\n",
  });
  rebuildIndex(fx.wiki);
  const result = validateSourceDiff(amuxdOpts(fx));
  assert.equal(result.ok, true, result.errors && result.errors.join("; "));
  const index = fs.readFileSync(path.join(fx.wiki, "index.md"), "utf8");
  assert.match(index, /amuxd-home-directory/);
  assert.doesNotMatch(index, /undefined/);
});

test("rebuildIndex then validate coerces a numeric summary instead of mismatching", () => {
  const fx = makeAmuxdWiki({
    "pages/amuxd-home-directory.md": amuxdPage({ summary: "2026", body: "# home\n" }),
    "index.md": "# LLM Wiki\n",
  });
  rebuildIndex(fx.wiki);
  const result = validateSourceDiff(amuxdOpts(fx));
  assert.equal(result.ok, true, result.errors && result.errors.join("; "));
});

test("rebuildIndex then validate indexes a heading that contains brackets", () => {
  const fx = makeAmuxdWiki({
    "pages/amuxd-home-directory.md": amuxdPage({
      body: "# [~/.amuxd] 目录说明\n\n家目录。\n",
    }),
    "index.md": "# LLM Wiki\n",
  });
  rebuildIndex(fx.wiki);
  const result = validateSourceDiff(amuxdOpts(fx));
  assert.equal(result.ok, true, result.errors && result.errors.join("; "));
  const index = fs.readFileSync(path.join(fx.wiki, "index.md"), "utf8");
  assert.match(index, /\[\[pages\/amuxd-home-directory\|/);
  assert.doesNotMatch(index, /\[\[pages\/amuxd-home-directory\|\[/);
});

test("index summary mismatch names both values", () => {
  const fx = makeAmuxdWiki({
    "pages/amuxd-home-directory.md": amuxdPage(),
    "index.md": `# LLM Wiki

## 流程
- [[pages/amuxd-home-directory|\`~/.amuxd\` 目录说明]] — WRONG SUMMARY
`,
  });
  const result = validateSourceDiff(amuxdOpts(fx));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /index summary mismatch for pages\/amuxd-home-directory\.md/);
  assert.match(result.errors.join("\n"), /WRONG SUMMARY/);
  assert.match(result.errors.join("\n"), /本机 amuxd 家目录/);
});
