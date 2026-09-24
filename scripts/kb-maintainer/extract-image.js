"use strict";

const { extensionOf, extractorCacheKey, withRawFrontmatter } = require("./extract-text");
const {
  imageLooksReadable,
  imageMediaType,
  classifyVisionError,
  readCachedResult,
  storeCachedResult,
} = require("./vision");

const EXTRACTOR = { name: "image-vision-v1", version: "1" };

async function extractImage(opts) {
  const ext = extensionOf(opts.sourcePath);
  const mediaType = imageMediaType(ext);
  const base = {
    sourcePath: opts.sourcePath,
    sourceSha256: opts.sourceSha256,
    bytes: opts.bytes,
    extractor: EXTRACTOR,
    mediaType: mediaType || "application/octet-stream",
    locators: ["image=1"],
  };
  if (!imageLooksReadable(ext, opts.bytes)) {
    return withRawFrontmatter({ ...base, body: "", quality: "vision_unreadable" });
  }
  if (typeof opts.visionExtract !== "function") {
    return withRawFrontmatter({ ...base, body: "", quality: "vision_declined" });
  }
  const cacheKey = extractorCacheKey({
    sourceSha256: opts.sourceSha256,
    extractorName: EXTRACTOR.name,
    extractorVersion: EXTRACTOR.version,
    visionModel: opts.visionModel || "",
    promptVersion: opts.promptVersion || "",
  });
  const cached = readCachedResult(opts, cacheKey);
  if (cached) return cached;
  let text = "";
  try {
    text = await opts.visionExtract({
      sourcePath: opts.sourcePath,
      sourceSha256: opts.sourceSha256,
      visionModel: opts.visionModel || "",
      promptVersion: opts.promptVersion || "",
      bytes: opts.bytes,
      mediaType,
      pageNumber: 1,
    });
  } catch (error) {
    throw classifyVisionError(error);
  }
  if (!String(text || "").trim()) {
    return withRawFrontmatter({ ...base, body: "", quality: "vision_empty" });
  }
  const result = withRawFrontmatter({
    ...base,
    body: `<!-- source-locator: image=1 -->\n${String(text).trim()}\n`,
    quality: "accepted",
  });
  storeCachedResult(opts, cacheKey, result);
  return result;
}

module.exports = { extractImage };
