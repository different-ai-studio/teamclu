"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWikiRepo, commitAll, headCommit } = require("./git-store");

test("commitAll is a no-op when the working tree is already clean", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-git-"));
  ensureWikiRepo(wikiRoot);
  const before = headCommit(wikiRoot);
  const after = commitAll(wikiRoot, "ingest(add): documents/handbook/leave.md@abcdef123456");
  assert.equal(after, before);
});
