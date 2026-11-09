"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { seedSchema, TEMPLATE_PATH } = require("./schema-seed");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kb-schema-seed-"));
}

test("seeds the template into a knowledge root that has none", () => {
  const root = tmp();
  assert.equal(seedSchema(root), true);
  assert.equal(
    fs.readFileSync(path.join(root, "_schema.md"), "utf8"),
    fs.readFileSync(TEMPLATE_PATH, "utf8"),
  );
});

test("never overwrites an existing schema, even an empty one", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "_schema.md"), "");
  assert.equal(seedSchema(root), false);
  assert.equal(fs.readFileSync(path.join(root, "_schema.md"), "utf8"), "");

  fs.writeFileSync(path.join(root, "_schema.md"), "# our rules\n");
  assert.equal(seedSchema(root), false);
  assert.equal(fs.readFileSync(path.join(root, "_schema.md"), "utf8"), "# our rules\n");
});

test("does not create a missing knowledge root", () => {
  const root = path.join(tmp(), "knowledge");
  assert.equal(seedSchema(root), false);
  assert.equal(fs.existsSync(root), false);
});
