"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertWikiPath } = require("./wiki-jail");

function workRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-jail-"));
  fs.mkdirSync(path.join(root, "wiki", "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "raw"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "wiki", "index.md"), "# LLM Wiki\n");
  return root;
}

test("assertWikiPath allows wiki pages and index", () => {
  const root = workRoot();
  const page = path.join(root, "wiki", "pages", "leave.md");
  fs.writeFileSync(page, "ok");
  assert.equal(assertWikiPath(root, page), fs.realpathSync(page));
  assert.equal(
    assertWikiPath(root, path.join(root, "wiki", "index.md")),
    fs.realpathSync(path.join(root, "wiki", "index.md")),
  );
  assert.equal(assertWikiPath(root, "pages/leave.md"), fs.realpathSync(page));
});

test("assertWikiPath rejects raw, state, vault, and parent escape", () => {
  const root = workRoot();
  assert.throws(() => assertWikiPath(root, path.join(root, "raw", "x.md")), /wiki/);
  assert.throws(() => assertWikiPath(root, path.join(root, "state", "state.json")), /wiki/);
  assert.throws(() => assertWikiPath(root, path.join(root, "wiki", "..", "raw", "x.md")), /wiki/);
  assert.throws(() => assertWikiPath(root, "/Users/other/secret.md"), /wiki/);
});
