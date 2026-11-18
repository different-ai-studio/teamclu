"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractText } = require("./extract-text");
const {
  extractedBodyLength,
  inspectLargeSource,
  planLargeSource,
  preflightLargeSources,
  MAX_PARTS,
} = require("./large-source");

const SHA = "cd".repeat(32);

function csvBytes(rows) {
  const lines = ["日期,车牌,司机,成本,备注"];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`2026-10-${String((index % 28) + 1).padStart(2, "0")},粤A${10000 + index},司机${index % 40},${(index * 7) % 900}.5,"线路 ${index % 9}, 含税"`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function extract(sourcePath, bytes) {
  return extractText({ sourcePath, bytes, sourceSha256: SHA });
}

test("inspectLargeSource leaves a source under the limit alone", () => {
  const bytes = csvBytes(10);
  const extracted = extract("documents/营运部/small.csv", bytes);
  assert.equal(inspectLargeSource({ sourcePath: "documents/营运部/small.csv", bytes, extracted, limit: 50000 }), null);
});

test("inspectLargeSource offers profile first for an over-limit table", () => {
  const sourcePath = "documents/营运部/整车成本_已拆分司机信息.csv";
  const bytes = csvBytes(3000);
  const extracted = extract(sourcePath, bytes);
  const info = inspectLargeSource({ sourcePath, bytes, extracted, limit: 50000 });
  assert.equal(info.kind, "table");
  assert.equal(info.encoding, "utf-8");
  assert.equal(info.chars, extractedBodyLength(extracted.markdown));
  assert.ok(info.chars > 50000);
  assert.ok(info.parts > 1 && info.parts <= MAX_PARTS, String(info.parts));
  assert.deepEqual(info.options, ["profile", "segment", "skip"]);
  assert.equal(info.defaultChoice, "profile");
});

test("segment parts repeat the header, cite row ranges, and each fit under the limit", () => {
  const sourcePath = "documents/营运部/成本.csv";
  const bytes = csvBytes(3000);
  const extracted = extract(sourcePath, bytes);
  const plan = planLargeSource({ sourcePath, bytes, extracted, choice: "segment", limit: 50000 });
  assert.equal(plan.mode, "segment");
  assert.ok(plan.units.length > 1);
  let expectedFirst = 2;
  for (const unit of plan.units) {
    assert.ok(extractedBodyLength(unit.rawMarkdown) <= 50000);
    assert.match(unit.rawMarkdown, /large_source_mode: segment/);
    assert.match(unit.rawMarkdown, /\| 日期 \| 车牌 \| 司机 \| 成本 \| 备注 \|/);
    assert.equal(unit.locators.length, 1);
    const [, first, last] = /^rows=(\d+)-(\d+)$/.exec(unit.locators[0]);
    assert.equal(Number(first), expectedFirst);
    expectedFirst = Number(last) + 1;
    assert.ok(plan.rawMarkdown.includes(`<!-- source-locator: ${unit.locators[0]} -->`));
  }
  assert.equal(expectedFirst, 3002);
  assert.equal(plan.units[0].part, 1);
  assert.equal(plan.units[0].parts, plan.units.length);
  assert.match(plan.rawMarkdown, /"?线路 3, 含税/);
});

test("profile replaces the rows with a column summary small enough to compile", () => {
  const sourcePath = "documents/营运部/成本.csv";
  const bytes = csvBytes(3000);
  const extracted = extract(sourcePath, bytes);
  const plan = planLargeSource({ sourcePath, bytes, extracted, choice: "profile", limit: 50000 });
  assert.equal(plan.mode, "profile");
  assert.equal(plan.units.length, 1);
  assert.ok(extractedBodyLength(plan.rawMarkdown) < 10000);
  assert.match(plan.rawMarkdown, /large_source_mode: profile/);
  assert.match(plan.rawMarkdown, /共 3000 行数据、5 列/);
  assert.match(plan.rawMarkdown, /\| 成本 \| 数值 \|/);
  assert.match(plan.rawMarkdown, /\| 日期 \| 日期 \|/);
  assert.deepEqual(plan.units[0].locators, ["profile", "columns", "sample"]);
  for (const locator of plan.units[0].locators) {
    assert.ok(plan.rawMarkdown.includes(`<!-- source-locator: ${locator} -->`));
  }
});

test("a long text with no breaks can only be skipped", () => {
  const sourcePath = "documents/营运部/长文.txt";
  const bytes = Buffer.from("没有标题的长文。".repeat(8000), "utf8");
  const extracted = extract(sourcePath, bytes);
  const info = inspectLargeSource({ sourcePath, bytes, extracted, limit: 50000 });
  assert.equal(info.kind, "document");
  assert.equal(info.parts, 0);
  assert.equal(info.reason, "no_breaks");
  assert.deepEqual(info.options, ["skip"]);
  assert.equal(info.defaultChoice, "skip");
  assert.throws(
    () => planLargeSource({ sourcePath, bytes, extracted, choice: "segment", limit: 50000 }),
    /^Error: too_large_unsplittable chars=\d+ limit=50000$/,
  );
});

test("a document with headings splits at headings and defaults to segment", () => {
  const sourcePath = "documents/制度/手册.md";
  const sections = Array.from({ length: 6 }, (_, index) => `## 第${index + 1}章\n\n${"条款内容。".repeat(3000)}\n`);
  const bytes = Buffer.from(`# 手册\n\n${sections.join("\n")}`, "utf8");
  const extracted = extract(sourcePath, bytes);
  const info = inspectLargeSource({ sourcePath, bytes, extracted, limit: 50000 });
  assert.deepEqual(info.options, ["segment", "skip"]);
  assert.equal(info.defaultChoice, "segment");
  const plan = planLargeSource({ sourcePath, bytes, extracted, choice: "segment", limit: 50000 });
  assert.equal(plan.units.length, info.parts);
  assert.deepEqual(plan.units[0].locators.slice(0, 2), ["heading=手册", "heading=第1章"]);
  assert.equal(plan.units.flatMap((unit) => unit.locators).length, 7);
});

test("a source needing more than the part cap offers profile or skip only", () => {
  const sourcePath = "documents/营运部/超大.csv";
  const bytes = csvBytes(30000);
  const extracted = extract(sourcePath, bytes);
  const info = inspectLargeSource({ sourcePath, bytes, extracted, limit: 50000 });
  assert.ok(info.parts > MAX_PARTS);
  assert.equal(info.reason, "too_many_parts");
  assert.deepEqual(info.options, ["profile", "skip"]);
  assert.throws(
    () => planLargeSource({ sourcePath, bytes, extracted, choice: "segment", limit: 50000 }),
    /^Error: too_many_parts parts=\d+ max=20$/,
  );
  const profile = planLargeSource({ sourcePath, bytes, extracted, choice: "profile", limit: 50000 });
  assert.match(profile.rawMarkdown, /共 30000 行数据/);
});

test("planLargeSource refuses an over-limit source nobody decided on, and honours skip", () => {
  const sourcePath = "documents/营运部/成本.csv";
  const bytes = csvBytes(3000);
  const extracted = extract(sourcePath, bytes);
  assert.throws(
    () => planLargeSource({ sourcePath, bytes, extracted, limit: 50000 }),
    /^Error: too_large chars=\d+ limit=50000$/,
  );
  assert.throws(() => planLargeSource({ sourcePath, bytes, extracted, choice: "skip", limit: 50000 }), /large_skipped/);
});

test("preflightLargeSources measures queued files and lists only the large ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-preflight-"));
  fs.mkdirSync(path.join(root, "营运部"), { recursive: true });
  fs.writeFileSync(path.join(root, "营运部", "big.csv"), csvBytes(3000));
  fs.writeFileSync(path.join(root, "营运部", "small.csv"), csvBytes(5));
  const found = await preflightLargeSources({
    documentsRoot: root,
    plan: {
      add: [{ path: "documents/营运部/big.csv" }, { path: "documents/营运部/small.csv" }],
      update: [{ path: "documents/营运部/missing.csv" }],
    },
    limit: 50000,
  });
  assert.deepEqual(found.map((item) => item.path), ["documents/营运部/big.csv"]);
});
