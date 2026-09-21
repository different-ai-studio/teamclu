#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { dryRun } = require("./dry-run");
const { estimateVision } = require("./estimate");
const { ingestBatch, loadState } = require("./ingest");
const { lintBatch } = require("./lint");
const { loadConfig } = require("./config");
const { buildPublishPlan, publishWiki } = require("./publish");
const { headCommit } = require("./git-store");

function summarizePreparedRun({ runId, plan, ingest, lint, estimate, publishPlan }) {
  const failures = (ingest.failures || []).map(
    (failure) => `${failure.path}: ${failure.error}`,
  );
  const policyBlocks = [...(plan.denied || []), ...(plan.blocked || [])].map(
    (item) => `${item.path}: ${item.reason}`,
  );
  const sourceCount =
    plan.add.length +
    plan.update.length +
    plan.delete.length +
    plan.unchanged.length +
    policyBlocks.length;
  const blockers = [
    ...(sourceCount === 0
      ? ["No source files were found in the selected folders."]
      : []),
    ...policyBlocks,
    ...failures,
    ...(lint.errors || []),
  ];
  return {
    runId,
    sourceCount,
    added: publishPlan.create.filter((item) => item.startsWith("pages/")).length,
    updated: publishPlan.update.filter((item) => item.startsWith("pages/")).length,
    deleted: publishPlan.delete.filter((item) => item.startsWith("pages/")).length,
    failed: failures.length,
    visionPages: estimate.visionPages,
    estimatedCost: estimate.estimatedCost,
    currency: estimate.currency,
    canPublish: blockers.length === 0,
    blockers,
  };
}

async function prepare(input) {
  const common = {
    configPath: input.configPath,
    statePath: input.statePath,
    documentsRoot: input.documentsRoot,
    knowledgeRoot: input.knowledgeRoot,
    workRoot: input.workRoot,
    nodeId: input.nodeId,
    known: input.known || [],
    aclPrefixes: input.aclPrefixes,
    runner: "pi",
    compilerModel: input.compilerModel || "default",
    acceptVisionEstimate: false,
  };
  const dry = dryRun(common);
  const estimate = await estimateVision(common);
  const ingest = await ingestBatch(common);
  const config = loadConfig(input.configPath);
  const wikiRoot = path.join(input.workRoot, "wiki");
  const state = loadState(input.statePath);
  const lint = lintBatch({ wikiRoot, state, config });
  const toCommit = headCommit(wikiRoot);
  const publishPlan = buildPublishPlan({
    wikiRoot,
    fromCommit: state.publishedCommit || null,
    toCommit,
  });
  return summarizePreparedRun({
    runId: input.runId,
    plan: dry.plan,
    ingest,
    lint,
    estimate,
    publishPlan,
  });
}

async function publish(input) {
  const config = loadConfig(input.configPath);
  const wikiRoot = path.join(input.workRoot, "wiki");
  const state = loadState(input.statePath);
  const lint = lintBatch({ wikiRoot, state, config });
  if (!lint.ok) {
    throw new Error(`quality check failed: ${lint.errors.join("; ")}`);
  }
  return publishWiki({
    wikiRoot,
    knowledgeRoot: input.knowledgeRoot,
    statePath: input.statePath,
    workRoot: input.workRoot,
  });
}

async function main() {
  const command = process.argv[2];
  const inputPath = process.argv[3];
  if (!command || !inputPath) {
    throw new Error("usage: desktop-runner.js <prepare|publish> <input.json>");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result =
    command === "prepare"
      ? await prepare(input)
      : command === "publish"
        ? await publish(input)
        : (() => {
            throw new Error(`unknown command: ${command}`);
          })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { prepare, publish, summarizePreparedRun };
