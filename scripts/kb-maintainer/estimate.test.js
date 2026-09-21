"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSimplePdf } = require("./extract-pdf");
const { estimateVision } = require("./estimate");

function write(file, textOrBuf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, textOrBuf);
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-est-"));
  const documentsRoot = path.join(root, "documents");
  const knowledgeRoot = path.join(root, "knowledge");
  write(path.join(knowledgeRoot, "_schema.md"), "# Wiki compile rules\n\nKeep facts sourced.\n");
  write(
    path.join(root, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      teamId: "11111111-1111-4111-8111-111111111111",
      maintainerNodeId: "node-a",
      sources: [
        {
          prefix: "documents/handbook/",
          class: "policy",
          priority: 10,
          allowExtensions: ["pdf", "md"],
        },
      ],
      deny: { pathPatterns: [] },
      models: { visionPagePrice: 0.12, currency: "CNY" },
    }),
  );
  return {
    root,
    documentsRoot,
    knowledgeRoot,
    configPath: path.join(root, "config.json"),
    statePath: path.join(root, "state.json"),
  };
}

test("estimateVision charges only low-quality PDF pages", async () => {
  const fx = makeHarness();
  write(
    path.join(fx.documentsRoot, "handbook", "scan.pdf"),
    buildSimplePdf([{ text: "", imageOnly: true }, { text: "", imageOnly: true }]),
  );
  write(
    path.join(fx.documentsRoot, "handbook", "text.pdf"),
    buildSimplePdf([{ text: "员工手册正文足够长，用来通过质量门禁。" }]),
  );

  const report = await estimateVision({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: [],
  });

  assert.equal(report.visionPages, 2);
  assert.equal(report.unitPrice, 0.12);
  assert.equal(report.estimatedCost, 0.24);
  assert.equal(report.currency, "CNY");
  assert.equal(report.requiresAccept, true);
  assert.deepEqual(
    report.sources.map((item) => item.path),
    ["documents/handbook/scan.pdf"],
  );
});

test("estimateVision is zero when every PDF already passes the text gate", async () => {
  const fx = makeHarness();
  write(
    path.join(fx.documentsRoot, "handbook", "text.pdf"),
    buildSimplePdf([{ text: "员工手册正文足够长，用来通过质量门禁。" }]),
  );
  const report = await estimateVision({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: [],
  });
  assert.equal(report.visionPages, 0);
  assert.equal(report.estimatedCost, 0);
  assert.equal(report.requiresAccept, false);
});
