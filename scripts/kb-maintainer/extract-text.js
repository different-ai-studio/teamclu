"use strict";

const crypto = require("node:crypto");

const EXTRACTORS = {
  md: { name: "text-md-v1", version: "1", mediaType: "text/markdown" },
  txt: { name: "text-txt-v1", version: "1", mediaType: "text/plain" },
  html: { name: "text-html-v1", version: "1", mediaType: "text/html" },
  htm: { name: "text-html-v1", version: "1", mediaType: "text/html" },
  csv: { name: "text-csv-v1", version: "1", mediaType: "text/csv" },
  json: { name: "text-json-v1", version: "1", mediaType: "application/json" },
  yaml: { name: "text-yaml-v1", version: "1", mediaType: "application/yaml" },
  yml: { name: "text-yaml-v1", version: "1", mediaType: "application/yaml" },
};

function extensionOf(sourcePath) {
  const base = sourcePath.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function extractorCacheKey({
  sourceSha256,
  extractorName,
  extractorVersion,
  visionModel = "",
  promptVersion = "",
}) {
  return crypto
    .createHash("sha256")
    .update(`${sourceSha256}\0${extractorName}\0${extractorVersion}\0${visionModel}\0${promptVersion}`)
    .digest("hex");
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n");
}

function extractMarkdownBody(text) {
  const locators = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      const locator = `heading=${match[2].trim()}`;
      locators.push(locator);
      out.push(`<!-- source-locator: ${locator} -->`);
      out.push(line);
    } else {
      out.push(line);
    }
  }
  if (locators.length === 0) {
    return { body: `<!-- source-locator: body -->\n${text.trim()}\n`, locators: ["body"] };
  }
  return { body: `${out.join("\n").trim()}\n`, locators };
}

function extractCsv(text) {
  const rows = text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((cell) => cell.trim()));
  if (rows.length === 0) return { body: "", locators: [] };
  const header = rows[0];
  const lines = [
    `<!-- source-locator: table -->`,
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return { body: `${lines.join("\n")}\n`, locators: ["table"] };
}

function extractJson(text) {
  const parsed = JSON.parse(text);
  const body = `<!-- source-locator: body -->\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
  return { body, locators: ["body"] };
}

function withRawFrontmatter({ sourcePath, sourceSha256, bytes, extractor, mediaType, body, locators, quality }) {
  const header = [
    "---",
    `source_path: ${sourcePath}`,
    `source_sha256: ${sourceSha256}`,
    `source_size: ${bytes.length}`,
    `media_type: ${mediaType}`,
    `extractor: ${extractor.name}`,
    `quality: ${quality}`,
    "---",
    "",
  ].join("\n");
  return {
    quality,
    extractorName: extractor.name,
    extractorVersion: extractor.version,
    locators,
    markdown: quality === "accepted" ? `${header}${body}` : header,
  };
}

function extractText({ sourcePath, bytes, sourceSha256 }) {
  const ext = extensionOf(sourcePath);
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    throw new Error(`unsupported text extension: ${ext || "(none)"}`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  let converted;
  if (ext === "html" || ext === "htm") converted = extractMarkdownBody(stripHtml(text));
  else if (ext === "csv") converted = extractCsv(text);
  else if (ext === "json") converted = extractJson(text);
  else if (ext === "yaml" || ext === "yml") converted = extractMarkdownBody(text);
  else if (ext === "txt") converted = extractMarkdownBody(text);
  else converted = extractMarkdownBody(text);

  const trimmed = converted.body.replace(/<!-- source-locator: .*? -->/g, "").trim();
  const quality = trimmed.length === 0 ? "empty" : "accepted";
  return withRawFrontmatter({
    sourcePath,
    sourceSha256,
    bytes,
    extractor,
    mediaType: extractor.mediaType,
    body: converted.body,
    locators: converted.locators,
    quality,
  });
}

function rawRelativePath(sourcePath) {
  return `${sourcePath}.md`;
}

module.exports = {
  EXTRACTORS,
  extractText,
  extractorCacheKey,
  extensionOf,
  withRawFrontmatter,
  rawRelativePath,
};
