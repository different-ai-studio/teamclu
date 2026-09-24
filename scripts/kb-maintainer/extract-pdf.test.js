"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractPdf, buildSimplePdf } = require("./extract-pdf");

const SHA = "cd".repeat(32);

test("extractPdf accepts a text PDF with page locators", async () => {
  const bytes = buildSimplePdf([{ text: "员工手册正文足够长，用来通过质量门禁。" }]);
  const result = await extractPdf({
    sourcePath: "documents/handbook/manual.pdf",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(result.quality, "accepted");
  assert.equal(result.extractorName, "pdf-text-v1");
  assert.match(result.markdown, /source-locator: page=1/);
  assert.match(result.markdown, /员工手册正文/);
});

test("extractPdf does not concatenate low-quality text with vision output", async () => {
  const bytes = buildSimplePdf([{ text: "", imageOnly: true }]);
  const visionCalls = [];
  const result = await extractPdf({
    sourcePath: "documents/training/scan.pdf",
    bytes,
    sourceSha256: SHA,
    visionModel: "team-vision",
    promptVersion: "v1",
    visionExtract: async ({ pageNumber }) => {
      visionCalls.push(pageNumber);
      return `# 扫描课件\n第 ${pageNumber} 页的可读文字。`;
    },
  });
  assert.equal(result.quality, "accepted");
  assert.equal(result.extractorName, "pdf-vision-v1");
  assert.match(result.markdown, /source-locator: page=1/);
  assert.match(result.markdown, /可读文字/);
  assert.doesNotMatch(result.markdown, /imageOnly|XObject|\?\?\?\?/);
  assert.deepEqual(visionCalls, [1]);
});

test("extractPdf fails closed when quality is low and vision is unavailable", async () => {
  const bytes = buildSimplePdf([{ text: "", imageOnly: true }]);
  const result = await extractPdf({
    sourcePath: "documents/training/scan.pdf",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(result.quality, "vision_declined");
});

test("extractPdf caches vision pages by extractor cache key", async () => {
  const bytes = buildSimplePdf([{ text: "", imageOnly: true }]);
  const cache = new Map();
  let calls = 0;
  const opts = {
    sourcePath: "documents/training/scan.pdf",
    bytes,
    sourceSha256: SHA,
    visionModel: "team-vision",
    promptVersion: "v1",
    cache,
    visionExtract: async () => {
      calls += 1;
      return "缓存页";
    },
  };
  const first = await extractPdf(opts);
  const second = await extractPdf(opts);
  assert.equal(calls, 1);
  assert.equal(first.markdown, second.markdown);
});
