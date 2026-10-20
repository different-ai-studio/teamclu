"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isRestrictedPath,
  restrictedDocumentPrefixes,
  restrictedSourceFolders,
} = require("./acl-preflight");

const whitelist = ["documents/handbook/", "documents/training/"];

test("restrictedDocumentPrefixes fails closed when ACL state is unknown", () => {
  assert.throws(() => restrictedDocumentPrefixes(null), /unknown|confirm/i);
  assert.throws(() => restrictedDocumentPrefixes(undefined), /unknown|confirm/i);
});

test("restrictedDocumentPrefixes keeps only documents/ prefixes, sorted and deduplicated", () => {
  assert.deepEqual(
    restrictedDocumentPrefixes([
      "knowledge/hr/",
      "documents/hr/",
      "documents/finance/",
      "documents/hr/",
      42,
    ]),
    ["documents/finance/", "documents/hr/"],
  );
  assert.deepEqual(restrictedDocumentPrefixes([]), []);
});

test("isRestrictedPath matches paths under a restricted folder", () => {
  const prefixes = ["documents/finance/", "documents/handbook/secret/"];
  assert.equal(isRestrictedPath("documents/finance/2026/q1.xlsx", prefixes), true);
  assert.equal(isRestrictedPath("documents/handbook/secret/pay.md", prefixes), true);
  assert.equal(isRestrictedPath("documents/handbook/leave.md", prefixes), false);
  assert.equal(isRestrictedPath("documents/finance-public/a.md", prefixes), false);
});

test("isRestrictedPath treats a prefix without a trailing slash as a folder or exact file", () => {
  assert.equal(isRestrictedPath("documents/finance/a.md", ["documents/finance"]), true);
  assert.equal(isRestrictedPath("documents/finance", ["documents/finance"]), true);
  assert.equal(isRestrictedPath("documents/financeX/a.md", ["documents/finance"]), false);
});

test("restrictedSourceFolders lists restricted prefixes that touch a source folder", () => {
  assert.deepEqual(restrictedSourceFolders(whitelist, []), []);
  assert.deepEqual(restrictedSourceFolders(whitelist, ["documents/personnel/"]), []);
  assert.deepEqual(restrictedSourceFolders(whitelist, ["documents/handbook/secret/"]), [
    "documents/handbook/secret/",
  ]);
  assert.deepEqual(restrictedSourceFolders(whitelist, ["documents/"]), ["documents/"]);
});
