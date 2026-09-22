"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDocumentsPath } = require("./paths");

test("normalizeDocumentsPath accepts posix documents-relative files", () => {
  assert.equal(
    normalizeDocumentsPath("documents/handbook/employee.pdf"),
    "documents/handbook/employee.pdf",
  );
});

test("normalizeDocumentsPath rejects parent-directory escape", () => {
  assert.throws(() => normalizeDocumentsPath("documents/../secrets.pdf"), /escape|illegal/i);
  assert.throws(() => normalizeDocumentsPath("documents/handbook/../../etc/passwd"), /escape|illegal/i);
});

test("normalizeDocumentsPath rejects absolute paths and backslashes", () => {
  assert.throws(() => normalizeDocumentsPath("/etc/passwd"), /escape|illegal|absolute/i);
  assert.throws(() => normalizeDocumentsPath("documents\\handbook\\a.pdf"), /escape|illegal/i);
});

test("normalizeDocumentsPath rejects paths outside documents/", () => {
  assert.throws(() => normalizeDocumentsPath("knowledge/wiki/index.md"), /documents/i);
  assert.throws(() => normalizeDocumentsPath("handbook/a.pdf"), /documents/i);
});

test("normalizeDocumentsPath rejects empty or directory-only paths", () => {
  assert.throws(() => normalizeDocumentsPath(""), /empty|illegal/i);
  assert.throws(() => normalizeDocumentsPath("documents/"), /file|illegal/i);
  assert.throws(() => normalizeDocumentsPath("documents"), /file|illegal/i);
});
