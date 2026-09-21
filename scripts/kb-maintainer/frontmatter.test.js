"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFrontmatter, serializeFrontmatter } = require("./frontmatter");

test("parseFrontmatter reads YAML-like page headers", () => {
  const parsed = parseFrontmatter(`---
type: policy
summary: 工作时间规则。
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/handbook/a.md
    sha256: ${"ab".repeat(32)}
    locators: ["heading=工作时间"]
updated: 2026-09-20
---

正文
`);
  assert.equal(parsed.frontmatter.type, "policy");
  assert.equal(parsed.frontmatter.managed_by, "llm-wiki");
  assert.equal(parsed.frontmatter.schema_version, 1);
  assert.equal(parsed.frontmatter.sources[0].path, "documents/handbook/a.md");
  assert.deepEqual(parsed.frontmatter.sources[0].locators, ["heading=工作时间"]);
  assert.equal(parsed.body.trim(), "正文");
});

test("serializeFrontmatter round-trips the Slice 2 page schema", () => {
  const page = {
    type: "policy",
    summary: "请假流程。",
    managed_by: "llm-wiki",
    schema_version: 1,
    sources: [
      {
        path: "documents/handbook/leave.md",
        sha256: "cd".repeat(32),
        locators: ["heading=请假"],
      },
    ],
    updated: "2026-09-20",
  };
  const serialized = serializeFrontmatter(page, "步骤一。");
  const parsed = parseFrontmatter(serialized);
  assert.deepEqual(parsed.frontmatter, page);
  assert.equal(parsed.body.trim(), "步骤一。");
});

test("parseFrontmatter reads YAML locator lists the compiler actually writes", () => {
  const parsed = parseFrontmatter(`---
type: process
summary: amuxd 家目录。
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/spec-docs/amuxd-home-directory.md
    sha256: ${"ab".repeat(32)}
    locators:
      - heading=\`~/.amuxd\` 目录说明
      - heading=切团队 / clear（易混点）
updated: 2026-09-21
---

家目录说明。
`);
  assert.deepEqual(parsed.frontmatter.sources[0].locators, [
    "heading=`~/.amuxd` 目录说明",
    "heading=切团队 / clear（易混点）",
  ]);
  assert.equal(parsed.body.trim(), "家目录说明。");
});

test("parseFrontmatter keeps a summary that looks like JSON but is not", () => {
  const parsed = parseFrontmatter(`---
type: process
summary: [本机] 家目录说明
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/spec-docs/amuxd-home-directory.md
    sha256: ${"ab".repeat(32)}
    locators: ["heading=home"]
updated: 2026-09-21
---

正文
`);
  assert.equal(parsed.frontmatter.summary, "[本机] 家目录说明");
});

test("serializeFrontmatter quotes summaries that would confuse the parser", () => {
  const page = {
    type: "process",
    summary: "[~/.amuxd] 目录说明",
    managed_by: "llm-wiki",
    schema_version: 1,
    sources: [
      {
        path: "documents/spec-docs/amuxd-home-directory.md",
        sha256: "ab".repeat(32),
        locators: ["heading=home"],
      },
    ],
    updated: "2026-09-21",
  };
  const serialized = serializeFrontmatter(page, "正文。");
  const parsed = parseFrontmatter(serialized);
  assert.equal(parsed.frontmatter.summary, "[~/.amuxd] 目录说明");
});
