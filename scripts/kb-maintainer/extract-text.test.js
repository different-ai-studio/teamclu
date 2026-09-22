"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractText, extractorCacheKey } = require("./extract-text");

function extract(sourcePath, text) {
  return extractText({
    sourcePath,
    bytes: Buffer.from(text, "utf8"),
    sourceSha256: "ab".repeat(32),
  });
}

test("extractText wraps markdown headings with stable locators", () => {
  const result = extract(
    "documents/handbook/leave.md",
    "# 请假\n\n说明。\n\n## 工作时间\n\n朝九晚六。\n",
  );
  assert.equal(result.quality, "accepted");
  assert.equal(result.extractorName, "text-md-v1");
  assert.match(result.markdown, /source-locator: heading=请假/);
  assert.match(result.markdown, /source-locator: heading=工作时间/);
  assert.deepEqual(result.locators, ["heading=请假", "heading=工作时间"]);
  assert.match(result.markdown, /^---\n/);
  assert.match(result.markdown, /source_path: documents\/handbook\/leave.md/);
  assert.match(result.markdown, /source_sha256: ab/);
});

test("extractText converts txt, html, csv, json, and yaml", () => {
  const txt = extract("documents/handbook/a.txt", "hello\nworld");
  assert.equal(txt.quality, "accepted");
  assert.match(txt.markdown, /source-locator: body/);
  assert.match(txt.markdown, /hello/);

  const html = extract("documents/handbook/a.html", "<h1>制度</h1><p>内容</p>");
  assert.match(html.markdown, /制度/);
  assert.doesNotMatch(html.markdown, /<h1>/);

  const csv = extract("documents/handbook/a.csv", "k,v\n加班,审批");
  assert.match(csv.markdown, /\| k \| v \|/);
  assert.match(csv.markdown, /加班/);

  const json = extract("documents/handbook/a.json", '{"title":"手册"}');
  assert.match(json.markdown, /手册/);

  const yaml = extract("documents/handbook/a.yaml", "title: 手册\n");
  assert.match(yaml.markdown, /手册/);
});

test("extractText rejects empty or whitespace-only sources", () => {
  const result = extract("documents/handbook/empty.md", "   \n");
  assert.equal(result.quality, "empty");
});

test("extractorCacheKey is stable and includes extractor identity", () => {
  const a = extractorCacheKey({
    sourceSha256: "aa",
    extractorName: "text-md-v1",
    extractorVersion: "1",
  });
  const b = extractorCacheKey({
    sourceSha256: "aa",
    extractorName: "text-md-v1",
    extractorVersion: "1",
  });
  const c = extractorCacheKey({
    sourceSha256: "aa",
    extractorName: "text-md-v1",
    extractorVersion: "2",
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, c);
});
