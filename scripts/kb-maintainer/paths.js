"use strict";

function fail(message) {
  const err = new Error(message);
  err.code = "KB_PATH";
  throw err;
}

function normalizeDocumentsPath(input) {
  if (typeof input !== "string" || input.length === 0) {
    fail("illegal documents path: empty");
  }
  if (input.includes("\\") || input.includes("\0")) {
    fail("illegal documents path: escape");
  }
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) {
    fail("illegal documents path: absolute");
  }
  if (input === "documents" || input === "documents/") {
    fail("illegal documents path: not a file");
  }
  if (!input.startsWith("documents/")) {
    fail("path must be under documents/");
  }
  const parts = input.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("illegal documents path: escape or directory-only");
  }
  if (parts.length < 2) {
    fail("illegal documents path: not a file");
  }
  return parts.join("/");
}

function normalizeDocumentsPrefix(input) {
  if (typeof input !== "string" || input.length === 0) {
    fail("illegal documents prefix: empty");
  }
  if (!input.endsWith("/")) {
    fail("source prefix must end with a slash");
  }
  if (input.includes("\\") || input.includes("\0") || input.includes("..")) {
    fail("source prefix escape is not allowed");
  }
  if (!input.startsWith("documents/")) {
    fail("source prefix must be under documents/");
  }
  const body = input.slice("documents/".length, -1);
  if (body.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("source prefix escape is not allowed");
  }
  return input;
}

function prefixesOverlap(a, b) {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

module.exports = {
  normalizeDocumentsPath,
  normalizeDocumentsPrefix,
  prefixesOverlap,
};
