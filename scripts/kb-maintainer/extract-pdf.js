"use strict";

const zlib = require("node:zlib");
const { extractorCacheKey, withRawFrontmatter } = require("./extract-text");

const TEXT_EXTRACTOR = { name: "pdf-text-v1", version: "1", mediaType: "application/pdf" };
const VISION_EXTRACTOR = { name: "pdf-vision-v1", version: "1", mediaType: "application/pdf" };
const MIN_COMPACT_CHARS = 8;
const PRINTABLE_RE = /[\t\n\r\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function pdfLiteralString(text) {
  const raw = Buffer.from(text, "utf8");
  const out = [Buffer.from("(")];
  for (const byte of raw) {
    if (byte === 0x5c || byte === 0x28 || byte === 0x29) out.push(Buffer.from([0x5c, byte]));
    else out.push(Buffer.from([byte]));
  }
  out.push(Buffer.from(")"));
  return Buffer.concat(out);
}

function objectBuffer(id, body) {
  return Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.from(body), Buffer.from("\nendobj\n")]);
}

function streamObject(id, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return objectBuffer(
    id,
    Buffer.concat([
      Buffer.from(`<< /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from("endstream"),
    ]),
  );
}

function buildSimplePdf(pages) {
  const objs = [];
  objs[3] = objectBuffer(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs[4] = Buffer.concat([
    Buffer.from("4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n"),
    Buffer.from([0]),
    Buffer.from("endstream\nendobj\n"),
  ]);

  const pageIds = [];
  let next = 5;
  for (const page of pages) {
    const text = page.text || "";
    const content =
      page.imageOnly && !text
        ? Buffer.from("q 100 0 0 100 72 500 cm /Im0 Do Q")
        : Buffer.concat([Buffer.from("BT /F1 12 Tf 72 720 Td "), pdfLiteralString(text), Buffer.from(" Tj ET")]);
    const contentId = next;
    next += 1;
    const pageId = next;
    next += 1;
    objs[contentId] = streamObject(contentId, content);
    const resources = page.imageOnly
      ? "<< /Font << /F1 3 0 R >> /XObject << /Im0 4 0 R >> >>"
      : "<< /Font << /F1 3 0 R >> >>";
    objs[pageId] = objectBuffer(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objs[2] = objectBuffer(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  objs[1] = objectBuffer(1, "<< /Type /Catalog /Pages 2 0 R >>");

  const header = Buffer.from("%PDF-1.4\n");
  const chunks = [header];
  const offsets = [0];
  let offset = header.length;
  const maxId = next - 1;
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = offset;
    offset += objs[id].length;
    chunks.push(objs[id]);
  }
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer));
  return Buffer.concat(chunks);
}

function parseObjects(bytes) {
  const src = bytes.toString("latin1");
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match;
  while ((match = re.exec(src))) {
    objects.set(Number(match[1]), match[2]);
  }
  return objects;
}

function objectStream(body) {
  const start = /stream\r?\n/.exec(body);
  if (!start) return Buffer.alloc(0);
  const dataStart = start.index + start[0].length;
  const end = body.indexOf("endstream", dataStart);
  if (end < 0) return Buffer.alloc(0);
  const dict = body.slice(0, start.index);
  const raw = Buffer.from(body.slice(dataStart, end), "latin1");
  const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
  const data = lengthMatch ? raw.subarray(0, Number(lengthMatch[1])) : raw;
  if (/\/Filter\s*\/FlateDecode/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode/.test(dict)) {
    return zlib.inflateSync(data);
  }
  return data;
}

function unescapePdfString(latin1) {
  const unescaped = latin1
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
  return Buffer.from(unescaped, "latin1").toString("utf8");
}

function extractContentText(content) {
  const src = content.toString("latin1");
  const out = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  let match;
  while ((match = re.exec(src))) {
    out.push(unescapePdfString(match[0].slice(1, -1)));
  }
  return out.join("");
}

function resolveContents(body, objects) {
  const match = /\/Contents\s+(\d+)\s+0\s+R/.exec(body);
  if (match) return objectStream(objects.get(Number(match[1])) || "");
  const array = /\/Contents\s*\[([^\]]+)\]/.exec(body);
  if (!array) return Buffer.alloc(0);
  return Buffer.concat(
    [...array[1].matchAll(/(\d+)\s+0\s+R/g)].map((ref) => objectStream(objects.get(Number(ref[1])) || "")),
  );
}

function pageQuality(text, imageOnly) {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) return imageOnly ? "low" : "empty";
  const printable = [...text].filter((ch) => PRINTABLE_RE.test(ch)).length;
  if (text.length > 0 && printable / text.length < 0.7) return "garbled";
  if (compact.length < MIN_COMPACT_CHARS) return "low";
  return "accepted";
}

function parsePages(bytes) {
  const objects = parseObjects(bytes);
  const pages = [];
  for (const [id, body] of objects) {
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) continue;
    const content = resolveContents(body, objects);
    const text = extractContentText(content);
    const imageOnly = /\/XObject\b/.test(body) && text.trim().length === 0;
    pages.push({
      id,
      number: pages.length + 1,
      text,
      imageOnly,
      quality: pageQuality(text, imageOnly),
    });
  }
  pages.sort((a, b) => a.id - b.id);
  pages.forEach((page, index) => {
    page.number = index + 1;
  });
  return pages;
}

function wrapPages(pages) {
  const locators = [];
  const body = pages
    .map((page) => {
      const locator = `page=${page.number}`;
      locators.push(locator);
      return `<!-- source-locator: ${locator} -->\n${page.text.trim()}`;
    })
    .join("\n\n");
  return { body: `${body}\n`, locators };
}

async function extractPdf(opts) {
  const {
    sourcePath,
    bytes,
    sourceSha256,
    visionExtract,
    visionModel = "",
    promptVersion = "",
    cache,
  } = opts;
  const pages = parsePages(bytes);
  const allAccepted = pages.length > 0 && pages.every((page) => page.quality === "accepted");
  if (allAccepted) {
    const converted = wrapPages(pages);
    return withRawFrontmatter({
      sourcePath,
      sourceSha256,
      bytes,
      extractor: TEXT_EXTRACTOR,
      mediaType: TEXT_EXTRACTOR.mediaType,
      body: converted.body,
      locators: converted.locators,
      quality: "accepted",
    });
  }

  if (typeof visionExtract === "function") {
    const cacheKey = extractorCacheKey({
      sourceSha256,
      extractorName: VISION_EXTRACTOR.name,
      extractorVersion: VISION_EXTRACTOR.version,
      visionModel,
      promptVersion,
    });
    if (cache?.has(cacheKey)) return cache.get(cacheKey);
    const visionPages = [];
    for (const page of pages) {
      const text = await visionExtract({
        pageNumber: page.number,
        sourcePath,
        sourceSha256,
        visionModel,
        promptVersion,
      });
      visionPages.push({ number: page.number, text: String(text || "") });
    }
    const converted = wrapPages(visionPages);
    const result = withRawFrontmatter({
      sourcePath,
      sourceSha256,
      bytes,
      extractor: VISION_EXTRACTOR,
      mediaType: VISION_EXTRACTOR.mediaType,
      body: converted.body,
      locators: converted.locators,
      quality: converted.body.replace(/<!-- source-locator: .*? -->/g, "").trim() ? "accepted" : "extraction_failed",
    });
    cache?.set(cacheKey, result);
    return result;
  }

  return withRawFrontmatter({
    sourcePath,
    sourceSha256,
    bytes,
    extractor: TEXT_EXTRACTOR,
    mediaType: TEXT_EXTRACTOR.mediaType,
    body: "",
    locators: pages.map((page) => `page=${page.number}`),
    quality: "extraction_failed",
  });
}

module.exports = { extractPdf, buildSimplePdf, parsePages };
