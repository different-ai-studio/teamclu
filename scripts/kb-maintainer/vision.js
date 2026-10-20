"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IMAGE_MEDIA = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function findPdftoppm(exists = fs.existsSync) {
  const candidates = ["/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"];
  for (const file of candidates) {
    if (exists(file)) return file;
  }
  return "pdftoppm";
}

function imageMediaType(ext) {
  return IMAGE_MEDIA[ext] || "";
}

function imageLooksReadable(ext, bytes) {
  if (!bytes || bytes.length < 12) return false;
  if (ext === "png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (ext === "jpg" || ext === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (ext === "webp") {
    return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function classifyVisionError(error) {
  const message = String(error && error.message ? error.message : error || "");
  if (message.startsWith("Compiler model failed:")) return new Error(message);
  if (
    message === "vision_unsupported" ||
    message === "vision_refused" ||
    message === "vision_empty" ||
    message === "vision_unreadable" ||
    message === "vision_declined" ||
    message === "vision_too_many_pages"
  ) {
    return new Error(message);
  }
  if (/content[_ ]?filter|content_policy|safety|moderation/i.test(message)) {
    return new Error("vision_refused");
  }
  if (
    /does not support image|image input|modalit|unsupported image|expected text only|only accepts text/i.test(
      message,
    )
  ) {
    return new Error("vision_unsupported");
  }
  return error instanceof Error ? error : new Error(message);
}

function assistantText(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      const detail = String(message.errorMessage || "unknown model error")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      throw new Error(`Compiler model failed: ${detail}`);
    }
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part && part.type === "text")
        .map((part) => String(part.text || ""))
        .join("")
        .trim();
    }
    return "";
  }
  return "";
}

async function transcribeWithSession(session, { bytes, mediaType, pageNumber }) {
  const prompt = pageNumber
    ? `Transcribe the words on page ${pageNumber}. Return only the transcription.`
    : "Transcribe the words in this image. Return only the transcription.";
  try {
    await session.prompt(prompt, {
      images: [
        {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: mediaType,
        },
      ],
    });
    if (typeof session.waitForIdle === "function") await session.waitForIdle();
  } catch (error) {
    throw classifyVisionError(error);
  }
  return assistantText(session);
}

function createVisionExtract({ transcribe, renderPdfPage }) {
  return async function visionExtract(payload) {
    let bytes = payload.bytes;
    let mediaType = payload.mediaType || "application/octet-stream";
    if (mediaType === "application/pdf") {
      if (typeof renderPdfPage !== "function") throw new Error("vision_unreadable");
      try {
        const rendered = await renderPdfPage(payload.bytes, payload.pageNumber);
        bytes = rendered.bytes;
        mediaType = rendered.mediaType || "image/png";
      } catch (error) {
        if (error && /^vision_/.test(String(error.message || ""))) throw error;
        throw new Error("vision_unreadable");
      }
    }
    return transcribe({ bytes, mediaType, pageNumber: payload.pageNumber });
  };
}

function readCachedResult(opts, cacheKey) {
  if (opts.cache?.has(cacheKey)) return opts.cache.get(cacheKey);
  if (!opts.cacheDir) return null;
  const file = path.join(opts.cacheDir, `${cacheKey}.json`);
  if (!fs.existsSync(file)) return null;
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  opts.cache?.set(cacheKey, result);
  return result;
}

function storeCachedResult(opts, cacheKey, result) {
  opts.cache?.set(cacheKey, result);
  if (!opts.cacheDir) return;
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(opts.cacheDir, `${cacheKey}.json`), JSON.stringify(result));
}

module.exports = {
  findPdftoppm,
  imageMediaType,
  imageLooksReadable,
  classifyVisionError,
  transcribeWithSession,
  createVisionExtract,
  readCachedResult,
  storeCachedResult,
};
