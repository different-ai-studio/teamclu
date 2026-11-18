"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  plainPathForNode,
  documentsFilePath,
  safeRealpathSync,
} = require("./win-path");

test("plainPathForNode strips a verbatim D: prefix and keeps Chinese segments", () => {
  assert.equal(
    plainPathForNode("\\\\?\\D:\\team\\documents\\AI行业应用\\群策.pdf"),
    "D:\\team\\documents\\AI行业应用\\群策.pdf",
  );
  assert.equal(plainPathForNode("\\\\?\\D:\\"), "D:\\");
  assert.equal(plainPathForNode("\\\\?\\D:"), "D:\\");
  assert.equal(
    plainPathForNode("//?/D:/team/documents/AI行业应用/"),
    "D:/team/documents/AI行业应用/",
  );
  assert.equal(
    plainPathForNode("\\\\?\\UNC\\server\\share\\AI行业应用"),
    "\\\\server\\share\\AI行业应用",
  );
});

test("plainPathForNode leaves POSIX paths, documents prefixes, and plain drives alone", () => {
  assert.equal(plainPathForNode("documents/AI行业应用/"), "documents/AI行业应用/");
  assert.equal(plainPathForNode("/tmp/documents/AI行业应用"), "/tmp/documents/AI行业应用");
  assert.equal(plainPathForNode("D:\\team\\documents"), "D:\\team\\documents");
  assert.equal(plainPathForNode("\\\\?\\PHYSICALDRIVE0"), "\\\\?\\PHYSICALDRIVE0");
});

test("documentsFilePath joins a D: root with a documents/ folder, including a trailing slash", () => {
  assert.equal(
    documentsFilePath("\\\\?\\D:\\team\\documents", "documents/AI行业应用/群策.pdf"),
    "D:\\team\\documents\\AI行业应用\\群策.pdf",
  );
  assert.equal(
    documentsFilePath("D:\\team\\documents\\", "documents/AI行业应用/群策.pdf"),
    "D:\\team\\documents\\AI行业应用\\群策.pdf",
  );
  assert.equal(
    documentsFilePath("\\\\?\\D:\\", "documents/AI行业应用/群策.pdf"),
    "D:\\AI行业应用\\群策.pdf",
  );
  assert.equal(
    documentsFilePath("/tmp/documents", "documents/AI行业应用/群策.pdf"),
    path.join("/tmp/documents", "AI行业应用/群策.pdf"),
  );
});

test("walking parents of a documents file on D: never reaches a bare drive letter", () => {
  let current = documentsFilePath(
    "\\\\?\\D:\\team\\documents",
    "documents/AI行业应用/群策.pdf",
  );
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    seen.push(current);
    const parent = path.win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assert.equal(seen.at(-1), "D:\\");
  assert.equal(seen.includes("D:"), false);
});

test("safeRealpathSync does not lstat a bare drive letter or a verbatim prefix", () => {
  const calls = [];
  const fake = {
    realpathSync: Object.assign(
      (value) => {
        calls.push(value);
        if (value === "D:" || String(value).startsWith("\\\\?\\")) {
          const error = new Error(`EISDIR: illegal operation on a directory, lstat '${value}'`);
          error.code = "EISDIR";
          throw error;
        }
        return value;
      },
      {
        native(value) {
          return fake.realpathSync(value);
        },
      },
    ),
  };
  assert.equal(safeRealpathSync("D:", fake), "D:\\");
  assert.equal(safeRealpathSync("\\\\?\\D:\\", fake), "D:\\");
  assert.equal(safeRealpathSync("D:/", fake), "D:\\");
  assert.equal(
    safeRealpathSync("\\\\?\\D:\\team\\wiki\\pages\\请假.md", fake),
    "D:\\team\\wiki\\pages\\请假.md",
  );
  assert.deepEqual(calls, ["D:\\team\\wiki\\pages\\请假.md"]);
});
