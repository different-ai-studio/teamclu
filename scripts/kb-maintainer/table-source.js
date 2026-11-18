"use strict";

const { unzip } = require("./zip");

function decodeText(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf.subarray(2)), encoding: "utf-16le" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    // Excel on Chinese Windows saves CSV as GBK; GB18030 is its superset.
    try {
      return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
    } catch {
      return { text: buf.toString("utf8"), encoding: "utf-8" };
    }
  }
}

/** RFC 4180: quoted cells may hold commas, doubled quotes, and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
      started = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== "" || row.length > 0) endRow();
  return rows
    .map((cells) => cells.map((value) => value.trim()))
    .filter((cells) => cells.some((value) => value !== ""));
}

function xmlDecode(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function textRuns(xml) {
  return [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join("");
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref || "");
  if (!letters) return -1;
  let index = 0;
  for (const ch of letters[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function xlsxSheets(bytes) {
  const files = unzip(bytes);
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1]));
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => xmlDecode(match[1]));
  const sheetFiles = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  return sheetFiles.map((file, sheetIndex) => {
    const xml = files.get(file).toString("utf8");
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      let next = 0;
      for (const cell of (rowMatch[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const ref = /\br="([^"]+)"/.exec(attrs);
        const at = ref ? columnIndex(ref[1]) : next;
        const inner = cell[2] || "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let text = "";
        if (/\bt="s"/.test(attrs)) text = value ? shared[Number(value[1])] || "" : "";
        else if (/\bt="inlineStr"/.test(attrs)) text = textRuns(inner);
        else if (value) text = xmlDecode(value[1]);
        cells[at] = text.trim();
        next = at + 1;
      }
      const filled = Array.from(cells, (value) => value || "");
      if (filled.some((value) => value !== "")) rows.push(filled);
    }
    return { name: names[sheetIndex] || `sheet${sheetIndex + 1}`, rows };
  });
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function markdownRow(cells, width) {
  const padded = Array.from({ length: Math.max(width, cells.length) }, (_, index) => markdownCell(cells[index]));
  return `| ${padded.join(" | ")} |`;
}

function markdownHeader(header) {
  return [markdownRow(header, header.length), `| ${header.map(() => "---").join(" | ")} |`];
}

const NUMBER_RE = /^[-+]?[¥$￥]?\d+(?:\.\d+)?%?$/;
const DATE_RE = /^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const MAX_TRACKED_VALUES = 2000;

function numericValue(text) {
  const plain = text.replace(/,/g, "").replace(/[¥$￥%]/g, "");
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

function short(text, max = 24) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function profileColumn(name, values) {
  const filled = values.filter((value) => value !== "");
  const counts = new Map();
  let overflow = false;
  for (const value of filled) {
    if (counts.has(value)) counts.set(value, counts.get(value) + 1);
    else if (counts.size < MAX_TRACKED_VALUES) counts.set(value, 1);
    else overflow = true;
  }
  const numeric = filled.length > 0 && filled.every((value) => NUMBER_RE.test(value.replace(/,/g, "")));
  const dated = !numeric && filled.length > 0 && filled.every((value) => DATE_RE.test(value));
  let type = "文本";
  let detail = "";
  if (filled.length === 0) {
    type = "空";
  } else if (numeric) {
    type = "数值";
    const numbers = filled.map(numericValue).filter((value) => value !== null);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    detail = `${min} ~ ${max}`;
  } else if (dated) {
    type = "日期";
    const sorted = [...filled].sort();
    detail = `${sorted[0]} ~ ${sorted[sorted.length - 1]}`;
  } else {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    detail = top.map(([value, count]) => `${short(value)}（${count}）`).join("、");
  }
  return {
    name: name || "(无列名)",
    type,
    filled: filled.length,
    distinct: overflow ? `${MAX_TRACKED_VALUES}+` : String(counts.size),
    detail,
  };
}

function profileTableLines({ header, rows, locatorPrefix, sampleRows = 5 }) {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const names = Array.from({ length: width }, (_, index) => header[index] || `第${index + 1}列`);
  const columns = names.map((name, index) => profileColumn(name, rows.map((row) => row[index] || "")));
  const columnLines = [
    `<!-- source-locator: ${locatorPrefix}columns -->`,
    "| 列名 | 类型 | 非空 | 不同取值 | 取值概况 |",
    "| --- | --- | --- | --- | --- |",
    ...columns.map(
      (column) =>
        `| ${markdownCell(column.name)} | ${column.type} | ${column.filled} | ${column.distinct} | ${markdownCell(column.detail)} |`,
    ),
  ];
  const sampleLines = [
    `<!-- source-locator: ${locatorPrefix}sample -->`,
    `示例行（前 ${Math.min(sampleRows, rows.length)} 行）：`,
    "",
    ...markdownHeader(names.map(short)),
    ...rows.slice(0, sampleRows).map((row) => markdownRow(row.map((value) => short(value, 40)), width)),
  ];
  return { width, columnLines, sampleLines };
}

module.exports = {
  decodeText,
  parseCsv,
  xlsxSheets,
  markdownCell,
  markdownRow,
  markdownHeader,
  profileTableLines,
};
