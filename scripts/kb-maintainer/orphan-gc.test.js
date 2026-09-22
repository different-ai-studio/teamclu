"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serializeFrontmatter } = require("./frontmatter");
const { gcOrphanPages } = require("./orphan-gc");

function writePage(wikiRoot, name, sources, body = `# ${name}\n\nbody\n`) {
  const abs = path.join(wikiRoot, "pages", name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    serializeFrontmatter(
      {
        type: "process",
        summary: name,
        managed_by: "llm-wiki",
        schema_version: 1,
        sources,
        updated: "2026-09-20",
      },
      body,
    ),
  );
}

test("gcOrphanPages deletes pages whose sources are all gone from state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-orphan-"));
  const wikiRoot = path.join(root, "wiki");
  writePage(wikiRoot, "gone.md", [
    {
      path: "documents/spec-docs/gone.md",
      sha256: "aa".repeat(32),
      locators: ["heading=gone"],
    },
  ]);
  writePage(wikiRoot, "kept.md", [
    {
      path: "documents/spec-docs/kept.md",
      sha256: "bb".repeat(32),
      locators: ["heading=kept"],
    },
  ]);
  fs.writeFileSync(path.join(wikiRoot, "index.md"), "# Index\n");

  const result = gcOrphanPages({
    wikiRoot,
    state: {
      sources: {
        "documents/spec-docs/kept.md": {
          status: "imported",
          sourceSha256: "bb".repeat(32),
        },
      },
    },
  });

  assert.deepEqual(result.removed, ["pages/gone.md"]);
  assert.equal(fs.existsSync(path.join(wikiRoot, "pages", "gone.md")), false);
  assert.equal(fs.existsSync(path.join(wikiRoot, "pages", "kept.md")), true);
  assert.match(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8"), /kept/);
  assert.doesNotMatch(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8"), /gone/);
});

test("gcOrphanPages strips a missing source and keeps the page when others remain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-orphan-"));
  const wikiRoot = path.join(root, "wiki");
  writePage(
    wikiRoot,
    "shared.md",
    [
      {
        path: "documents/handbook/a.md",
        sha256: "aa".repeat(32),
        locators: ["heading=a"],
      },
      {
        path: "documents/handbook/b.md",
        sha256: "bb".repeat(32),
        locators: ["heading=b"],
      },
    ],
    "# shared\n\nfrom a and b\n",
  );

  const result = gcOrphanPages({
    wikiRoot,
    state: {
      sources: {
        "documents/handbook/b.md": {
          status: "imported",
          sourceSha256: "bb".repeat(32),
        },
      },
    },
  });

  assert.deepEqual(result.rewritten, ["pages/shared.md"]);
  const text = fs.readFileSync(path.join(wikiRoot, "pages", "shared.md"), "utf8");
  assert.match(text, /documents\/handbook\/b\.md/);
  assert.doesNotMatch(text, /documents\/handbook\/a\.md/);
});
