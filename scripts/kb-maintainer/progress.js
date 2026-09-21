"use strict";

const PROGRESS_PREFIX = "KB_PROGRESS ";

function writeProgress(event, write = (line) => process.stderr.write(line)) {
  write(`${PROGRESS_PREFIX}${JSON.stringify(event)}\n`);
}

function parseProgressLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith(PROGRESS_PREFIX)) return null;
  try {
    return JSON.parse(trimmed.slice(PROGRESS_PREFIX.length));
  } catch {
    return null;
  }
}

module.exports = { PROGRESS_PREFIX, writeProgress, parseProgressLine };
