"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { adoptExistingWiki, inspectExistingWiki } = require("./adopt");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("adopt copies sourced vault pages into the initial checkpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-adopt-"));
  const knowledgeRoot = path.join(root, "knowledge");
  const workRoot = path.join(root, "work");
  write(
    path.join(knowledgeRoot, "wiki", "pages", "leave.md"),
    "---\nsources:\n  - path: documents/handbook/leave.md\n---\n# Leave\n",
  );
  write(path.join(knowledgeRoot, "wiki", "index.md"), "# LLM Wiki\n");
  write(
    path.join(workRoot, "config.json"),
    `${JSON.stringify({ schemaVersion: 1, teamId: "11111111-1111-1111-1111-111111111111", sources: [] })}\n`,
  );
  const adopted = adoptExistingWiki({
    knowledgeRoot,
    workRoot,
    configPath: path.join(workRoot, "config.json"),
    teamId: "11111111-1111-1111-1111-111111111111",
    expectedGeneration: 0,
    configVersion: 1,
    nodeId: "node-a",
    compilerModel: "default",
  });
  assert.equal(adopted.manifest.baseline, true);
  assert.equal(adopted.manifest.generation, 1);
  assert.equal(adopted.adoptedCommit, adopted.wikiHead);
});

test("adopt refuses a vault page that does not cite sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-adopt-bad-"));
  write(path.join(root, "knowledge", "wiki", "pages", "leave.md"), "# Leave\n");
  assert.equal(inspectExistingWiki(path.join(root, "knowledge")).needsAdopt, true);
  assert.throws(
    () =>
      adoptExistingWiki({
        knowledgeRoot: path.join(root, "knowledge"),
        workRoot: path.join(root, "work"),
        configPath: path.join(root, "work", "config.json"),
        teamId: "11111111-1111-1111-1111-111111111111",
        expectedGeneration: 0,
        configVersion: 1,
        nodeId: "node-a",
      }),
    /missing sources/,
  );
});
