"use strict";

const { unzip } = require("./zip");
const { withRawFrontmatter } = require("./extract-text");

function xmlTexts(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let match;
  while ((match = re.exec(xml))) {
    out.push(decodeXml(match[1].replace(/<[^>]+>/g, "")));
  }
  return out;
}

function decodeXml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractDocx(files) {
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("docx missing word/document.xml");
  const paragraphs = xml
    .toString("utf8")
    .split(/<w:p[\s>]/)
    .slice(1)
    .map((block) => xmlTexts(block, "w:t").join(""))
    .map((text) => text.trim())
    .filter(Boolean);
  const locators = [];
  const body = paragraphs
    .map((para, index) => {
      const locator = `para=${index + 1}`;
      locators.push(locator);
      return `<!-- source-locator: ${locator} -->\n${para}`;
    })
    .join("\n\n");
  return { body: `${body}\n`, locators };
}

function extractPptx(files) {
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const locators = [];
  const parts = slides.map((name) => {
    const num = Number(/\d+/.exec(name)[0]);
    const locator = `slide=${num}`;
    locators.push(locator);
    const text = xmlTexts(files.get(name).toString("utf8"), "a:t").join("\n").trim();
    return `<!-- source-locator: ${locator} -->\n${text}`;
  });
  return { body: `${parts.join("\n\n")}\n`, locators };
}

function extractXlsx(files) {
  const shared = files.get("xl/sharedStrings.xml")
    ? xmlTexts(files.get("xl/sharedStrings.xml").toString("utf8"), "t")
    : [];
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const sheetNames = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((match) => match[1]);
  const locators = [];
  const parts = [];
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  sheets.forEach((name, index) => {
    const sheetName = sheetNames[index] || `sheet${index + 1}`;
    const xml = files.get(name).toString("utf8");
    const rows = xml.split(/<row\b/).slice(1);
    rows.forEach((rowXml, rowIndex) => {
      const cells = [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const isShared = /\bt="s"/.test(cell[1]);
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]);
        if (!value) return "";
        if (isShared) return shared[Number(value[1])] || "";
        return value[1];
      });
      const line = cells.filter(Boolean).join(" | ");
      if (!line) return;
      const locator = `sheet=${sheetName}&row=${rowIndex + 1}`;
      locators.push(locator);
      parts.push(`<!-- source-locator: ${locator} -->\n${line}`);
    });
  });
  return { body: `${parts.join("\n\n")}\n`, locators };
}

function extractOffice({ sourcePath, bytes, sourceSha256 }) {
  const ext = sourcePath.split(".").pop().toLowerCase();
  const files = unzip(bytes);
  const meta = {
    docx: { name: "office-docx-v1", version: "1", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    pptx: { name: "office-pptx-v1", version: "1", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    xlsx: { name: "office-xlsx-v1", version: "1", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  }[ext];
  if (!meta) throw new Error(`unsupported office extension ${ext}`);
  const converted = ext === "docx" ? extractDocx(files) : ext === "pptx" ? extractPptx(files) : extractXlsx(files);
  const quality = converted.body.replace(/<!-- source-locator: .*? -->/g, "").trim() ? "accepted" : "empty";
  return withRawFrontmatter({
    sourcePath,
    sourceSha256,
    bytes,
    extractor: meta,
    mediaType: meta.mediaType,
    body: converted.body,
    locators: converted.locators,
    quality,
  });
}

module.exports = { extractOffice };
