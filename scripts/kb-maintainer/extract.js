"use strict";

const { extractText, extensionOf, withRawFrontmatter } = require("./extract-text");
const { extractOffice } = require("./extract-office");
const { extractPdf } = require("./extract-pdf");
const { extractImage } = require("./extract-image");

const TEXT_EXTS = new Set(["md", "txt", "html", "htm", "csv", "json", "yaml", "yml"]);
const OFFICE_EXTS = new Set(["docx", "pptx", "xlsx"]);
const PDF_EXTS = new Set(["pdf"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
const AV_EXTS = new Set(["mp3", "mp4", "mov", "wav", "m4a"]);

async function extractSource(opts) {
  const ext = extensionOf(opts.sourcePath);
  if (TEXT_EXTS.has(ext)) return extractText(opts);
  if (OFFICE_EXTS.has(ext)) return extractOffice(opts);
  if (PDF_EXTS.has(ext)) return extractPdf(opts);
  if (IMAGE_EXTS.has(ext)) return extractImage(opts);
  if (AV_EXTS.has(ext)) {
    return withRawFrontmatter({
      sourcePath: opts.sourcePath,
      sourceSha256: opts.sourceSha256,
      bytes: opts.bytes,
      extractor: { name: "av-unsupported-v1", version: "1" },
      mediaType: "application/octet-stream",
      body: "",
      locators: [],
      quality: "unsupported",
    });
  }
  throw new Error(`unsupported source extension: ${ext || "(none)"}`);
}

module.exports = { extractSource };
