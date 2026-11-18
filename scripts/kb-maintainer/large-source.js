"use strict";

const fs = require("node:fs");
const { extensionOf } = require("./extract-text");
const {
  decodeText,
  parseCsv,
  xlsxSheets,
  markdownHeader,
  markdownRow,
  profileTableLines,
} = require("./table-source");
const { documentsFilePath } = require("./win-path");

const DEFAULT_MAX_EXTRACTED_CHARS = 50000;
// A part leaves room under the limit for the repeated table header and the
// locator comments, so a part never trips the same check it was cut to pass.
const PART_BUDGET_RATIO = 0.8;
const MAX_PARTS = 20;
const TABLE_EXTS = new Set(["csv", "xlsx"]);
const LOCATOR_RE = /<!-- source-locator: (.*?) -->/g;

function extractedBodyLength(markdown) {
  return String(markdown || "").replace(/^---[\s\S]*?\n---\n/, "").length;
}

function splitRaw(markdown) {
  const match = /^---[\s\S]*?\n---\n/.exec(markdown);
  if (!match) return { header: "", body: markdown };
  return { header: match[0], body: markdown.slice(match[0].length) };
}

function withMode(header, mode) {
  if (!header) return header;
  return header.replace(/\n---\n$/, `\nlarge_source_mode: ${mode}\n---\n`);
}

function fileName(sourcePath) {
  return sourcePath.split("/").pop() || sourcePath;
}

function isTable(sourcePath) {
  return TABLE_EXTS.has(extensionOf(sourcePath));
}

function locatorBlocks(body) {
  const marks = [...body.matchAll(LOCATOR_RE)];
  if (marks.length === 0) return [];
  return marks.map((mark, index) => {
    const start = index === 0 ? 0 : mark.index;
    const end = index + 1 < marks.length ? marks[index + 1].index : body.length;
    return { locators: [mark[1]], text: body.slice(start, end).replace(/\s+$/, "") };
  });
}

function packBlocks(blocks, budget) {
  const parts = [];
  let current = null;
  for (const block of blocks) {
    if (block.text.length > budget) return null;
    if (current && current.text.length + 2 + block.text.length > budget) {
      parts.push(current);
      current = null;
    }
    if (!current) {
      current = { locators: [...block.locators], text: block.text };
    } else {
      current.locators.push(...block.locators);
      current.text = `${current.text}\n\n${block.text}`;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function csvTable(bytes) {
  const decoded = decodeText(bytes);
  const rows = parseCsv(decoded.text);
  return { encoding: decoded.encoding, header: rows[0] || [], rows: rows.slice(1) };
}

/** Header row is row 1, so data rows are numbered from 2 like a spreadsheet. */
function csvParts(table, budget) {
  const width = Math.max(table.header.length, ...table.rows.map((row) => row.length), 0);
  const headerText = markdownHeader(table.header).join("\n");
  const parts = [];
  let lines = [];
  let first = 0;
  let size = 0;
  const flush = (endExclusive) => {
    if (lines.length === 0) return;
    const locator = `rows=${first + 2}-${endExclusive + 1}`;
    parts.push({
      locators: [locator],
      text: `<!-- source-locator: ${locator} -->\n${headerText}\n${lines.join("\n")}`,
    });
    lines = [];
  };
  const overhead = headerText.length + 64;
  for (let index = 0; index < table.rows.length; index += 1) {
    const line = markdownRow(table.rows[index], width);
    if (overhead + line.length > budget) return null;
    if (lines.length > 0 && overhead + size + line.length + 1 > budget) {
      flush(index);
      size = 0;
    }
    if (lines.length === 0) first = index;
    lines.push(line);
    size += line.length + 1;
  }
  flush(table.rows.length);
  return parts;
}

function sourceParts({ sourcePath, bytes, extracted, budget }) {
  if (extensionOf(sourcePath) === "csv") {
    const table = csvTable(bytes);
    return { parts: csvParts(table, budget), encoding: table.encoding };
  }
  const { body } = splitRaw(extracted.markdown);
  const blocks = locatorBlocks(body);
  return { parts: blocks.length > 0 ? packBlocks(blocks, budget) : null };
}

function profileBody({ sourcePath, bytes, withSamples }) {
  const name = fileName(sourcePath);
  const lines = [`# 《${name}》表结构概况`, ""];
  if (extensionOf(sourcePath) === "csv") {
    const table = csvTable(bytes);
    const profile = profileTableLines({ header: table.header, rows: table.rows, locatorPrefix: "" });
    lines.push(
      "<!-- source-locator: profile -->",
      `这是表格资料的结构概况，不含全部明细。原文件 ${sourcePath} 共 ${table.rows.length} 行数据、${profile.width} 列，文件编码 ${table.encoding}。明细请到资料库查看原文件。`,
      "",
      ...profile.columnLines,
      "",
    );
    if (withSamples) lines.push(...profile.sampleLines, "");
    return { body: lines.join("\n"), locators: collectLocators(lines) };
  }
  const sheets = xlsxSheets(bytes);
  lines.push(
    "<!-- source-locator: profile -->",
    `这是表格资料的结构概况，不含全部明细。原文件 ${sourcePath} 共 ${sheets.length} 个工作表，明细请到资料库查看原文件。`,
    "",
  );
  for (const sheet of sheets) {
    const header = sheet.rows[0] || [];
    const rows = sheet.rows.slice(1);
    const prefix = `sheet=${sheet.name}&`;
    const profile = profileTableLines({ header, rows, locatorPrefix: prefix });
    lines.push(
      `## 工作表：${sheet.name}`,
      "",
      `<!-- source-locator: ${prefix}profile -->`,
      `共 ${rows.length} 行数据、${profile.width} 列。`,
      "",
      ...profile.columnLines,
      "",
    );
    if (withSamples) lines.push(...profile.sampleLines, "");
  }
  return { body: lines.join("\n"), locators: collectLocators(lines) };
}

function collectLocators(lines) {
  return lines
    .map((line) => /^<!-- source-locator: (.*?) -->$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
}

function limitOf(limit) {
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_EXTRACTED_CHARS;
}

/**
 * Measure one extracted source without calling a model. Returns null when it
 * fits; otherwise what the person can choose for it.
 */
function inspectLargeSource({ sourcePath, bytes, extracted, limit }) {
  const max = limitOf(limit);
  const chars = extractedBodyLength(extracted.markdown);
  if (chars <= max) return null;
  const budget = Math.floor(max * PART_BUDGET_RATIO);
  const table = isTable(sourcePath);
  const { parts, encoding } = sourceParts({ sourcePath, bytes, extracted, budget });
  const count = parts ? parts.length : 0;
  const splittable = count > 0 && count <= MAX_PARTS;
  const options = [
    ...(table ? ["profile"] : []),
    ...(splittable ? ["segment"] : []),
    "skip",
  ];
  return {
    path: sourcePath,
    chars,
    limit: max,
    kind: table ? "table" : "document",
    ...(encoding ? { encoding } : {}),
    parts: count,
    maxParts: MAX_PARTS,
    ...(splittable ? {} : { reason: count > MAX_PARTS ? "too_many_parts" : "no_breaks" }),
    options,
    defaultChoice: table ? "profile" : splittable ? "segment" : "skip",
  };
}

/**
 * Turn an over-limit source into the units the compiler sees, per the choice
 * made in the preflight. `rawMarkdown` is what goes to raw/, so every locator
 * a unit cites can be checked against it.
 */
function planLargeSource({ sourcePath, bytes, extracted, choice, limit }) {
  const max = limitOf(limit);
  const chars = extractedBodyLength(extracted.markdown);
  if (chars <= max) return null;
  if (!choice) throw new Error(`too_large chars=${chars} limit=${max}`);
  if (choice === "skip") throw new Error("large_skipped");
  const { header } = splitRaw(extracted.markdown);
  if (choice === "profile") {
    if (!isTable(sourcePath)) throw new Error(`too_large chars=${chars} limit=${max}`);
    let profile = profileBody({ sourcePath, bytes, withSamples: true });
    if (profile.body.length > max) profile = profileBody({ sourcePath, bytes, withSamples: false });
    if (profile.body.length > max) {
      throw new Error(`too_large_unsplittable chars=${chars} limit=${max}`);
    }
    const rawMarkdown = `${withMode(header, "profile")}${profile.body}`;
    return { mode: "profile", rawMarkdown, units: [{ rawMarkdown, locators: profile.locators }] };
  }
  if (choice !== "segment") throw new Error(`too_large chars=${chars} limit=${max}`);
  const budget = Math.floor(max * PART_BUDGET_RATIO);
  const { parts } = sourceParts({ sourcePath, bytes, extracted, budget });
  if (!parts || parts.length === 0) {
    throw new Error(`too_large_unsplittable chars=${chars} limit=${max}`);
  }
  if (parts.length > MAX_PARTS) throw new Error(`too_many_parts parts=${parts.length} max=${MAX_PARTS}`);
  const partHeader = withMode(header, "segment");
  return {
    mode: "segment",
    rawMarkdown: `${partHeader}${parts.map((part) => part.text).join("\n\n")}\n`,
    units: parts.map((part, index) => ({
      rawMarkdown: `${partHeader}${part.text}\n`,
      locators: part.locators,
      part: index + 1,
      parts: parts.length,
    })),
  };
}

/** Extract every queued source locally, without vision, and list the ones over the limit. */
async function preflightLargeSources({ documentsRoot, plan, limit }) {
  const { extractSource } = require("./extract");
  const found = [];
  for (const item of [...(plan.add || []), ...(plan.update || [])]) {
    const abs = documentsFilePath(documentsRoot, item.path);
    if (!fs.existsSync(abs)) continue;
    let bytes;
    let extracted;
    try {
      bytes = fs.readFileSync(abs);
      extracted = await extractSource({ sourcePath: item.path, bytes, sourceSha256: item.sourceSha256 });
    } catch {
      continue;
    }
    if (extracted.quality !== "accepted") continue;
    let info;
    try {
      info = inspectLargeSource({ sourcePath: item.path, bytes, extracted, limit });
    } catch {
      continue;
    }
    if (info) found.push(info);
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  DEFAULT_MAX_EXTRACTED_CHARS,
  preflightLargeSources,
  MAX_PARTS,
  extractedBodyLength,
  inspectLargeSource,
  planLargeSource,
};
