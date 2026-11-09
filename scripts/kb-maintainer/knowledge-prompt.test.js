"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PROMPT_FILE = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "daemon",
  "assets",
  "pi-extension",
  "teamclu.ts",
);

test("session knowledge prompt routes questions through wiki/index.md", () => {
  const source = fs.readFileSync(PROMPT_FILE, "utf8");
  assert.match(source, /KNOWLEDGE_VAULT_PROMPT/);
  assert.match(source, /wiki\/index\.md/);
  assert.match(source, /maxChars 12000|maxChars: 12000/);
  assert.match(source, /pathPrefix wiki/);
  assert.match(source, /the Wiki wins/);
});
