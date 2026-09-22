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
const { commitAll, headCommit } = require("./git-store");
const { gcOrphanPages } = require("./orphan-gc");
const { repairWiki } = require("./repair");

const SKIPPED =
  "This source was skipped this run and will be compiled again next time.";

function explainFailure(error) {
  const text = String(error || "");
  if (text === "too_large" || /\btoo_large\b/.test(text) || /^size \d+/.test(text)) {
    return "This source is too long. Split it into shorter files, then compile again.";
  }
  if (
    /^extension /.test(text) ||
    /^extraction /.test(text) ||
    /unsupported source extension/.test(text) ||
    /unsupported text extension/.test(text) ||
    /unsupported office/.test(text)
  ) {
    return "This source could not be read. Replace it with a text file, then try again.";
  }
  if (/^deny pattern\b/.test(text) || text === "sensitive filename") {
    return "This file is excluded from Wiki. Choose a different folder.";
  }
  if (/^unknown class /.test(text)) {
    return "This folder is not set up for Wiki compile. Choose another folder.";
  }
  if (
    /compiler produced no wiki pages|dead wiki link|did not retract|PII|internal leak|copy ratio|illegal type|unreadable frontmatter|managed_by|schema_version|sha256 mismatch|locator not in raw|exceeds \d+ chars|source-summary too large|index summary mismatch|index missing|index repeats|index points|changed \d+ pages|diff escapes|link not allowed|missing frontmatter|unterminated frontmatter|sources required|quality check failed|source not in current set|wiki\/index\.md is missing|path escapes|raw cache missing/.test(
      text,
    )
  ) {
    return SKIPPED;
  }
  return text;
}

function pageChanges(items) {
  return (items || []).filter((item) => String(item).startsWith("pages/")).length;
}

function summarizePreparedRun({ runId, plan, ingest, lint, estimate, publishPlan }) {
  const failures = (ingest.failures || []).map(
    (failure) => `${failure.path}: ${explainFailure(failure.error)}`,
  );
  const lintBlockers = [];
  let skippedLint = false;
  for (const error of lint.errors || []) {
    const explained = explainFailure(error);
    if (explained === SKIPPED) {
      skippedLint = true;
      continue;
    }
    lintBlockers.push(explained);
  }
  if (skippedLint) lintBlockers.unshift(SKIPPED);
  const policyBlocks = [...(plan.denied || []), ...(plan.blocked || [])].map(
    (item) => `${item.path}: ${explainFailure(item.reason)}`,
  );
  // Present sources only — deleted-from-disk retracts are counted separately so
  // the UI does not look like "3 files" when the vault only has 1 left.
  const sourceCount =
    plan.add.length + plan.update.length + plan.unchanged.length + policyBlocks.length;
  const retractCount = plan.delete.length;
  const added = pageChanges(publishPlan.create);
  const updated = pageChanges(publishPlan.update);
  const deleted = pageChanges(publishPlan.delete);
  const emptySelection = sourceCount === 0 && retractCount === 0;
  const lintErrors = lint.errors || [];
  // A source that fails is rolled back on its own. Sources that passed stay
  // committed, so they can be published while the failures wait for a later run.
  const blockers = [
    ...(emptySelection ? ["No source files were found in the selected folders."] : []),
    ...policyBlocks,
    ...failures,
    ...lintBlockers,
  ];
  return {
    runId,
    sourceCount,
    retractCount,
    added,
    updated,
    deleted,
    failed: failures.length,
    visionPages: estimate.visionPages,
    estimatedCost: estimate.estimatedCost,
    currency: estimate.currency,
    canPublish: !emptySelection && lintErrors.length === 0 && added + updated + deleted > 0,
    blockers,
  };
}

async function prepare(input, hooks = {}) {
  const onProgress =
    typeof hooks.onProgress === "function" ? hooks.onProgress : () => {};
  const common = {
    configPath: input.configPath,
    statePath: input.statePath,
    documentsRoot: input.documentsRoot,
    knowledgeRoot: input.knowledgeRoot,
    workRoot: input.workRoot,
    nodeId: input.nodeId,
    known: input.known || [],
    aclPrefixes: input.aclPrefixes,
    runner: input.runner || "pi",
    compilerModel: input.compilerModel || "default",
    acceptVisionEstimate: false,
    createSession: input.createSession,
    onProgress,
  };
  onProgress({ stage: "plan" });
  const dry = dryRun(common);
  onProgress({ stage: "estimate" });
  const estimate = await estimateVision(common);
  const ingest = await ingestBatch(common);
  onProgress({ stage: "lint" });
  const config = loadConfig(input.configPath);
  const wikiRoot = path.join(input.workRoot, "wiki");
  const state = loadState(input.statePath);
  // Previous failed retracts can leave wiki pages that still cite deleted
  // sources while state no longer tracks them. Drop those orphans before lint.
  const orphans = gcOrphanPages({ wikiRoot, state });
  const repaired = repairWiki(wikiRoot, {
    state,
    maxBytes: config.limits?.maxIndexChars || 8000,
  });
  if (
    orphans.removed.length > 0 ||
    orphans.rewritten.length > 0 ||
    repaired.changed
  ) {
    commitAll(wikiRoot, "wiki: repair compiled pages");
  }
  const lint = lintBatch({ wikiRoot, state, config });
  const toCommit = headCommit(wikiRoot);
  const publishPlan = buildPublishPlan({
    wikiRoot,
    fromCommit: state.publishedCommit || null,
    toCommit,
  });
  onProgress({ stage: "done" });
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
  const repaired = repairWiki(wikiRoot, {
    state,
    maxBytes: config.limits?.maxIndexChars || 8000,
  });
  if (repaired.changed) {
    commitAll(wikiRoot, "wiki: repair compiled pages");
  }
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

const { writeProgress } = require("./progress");

async function main() {
  const command = process.argv[2];
  const inputPath = process.argv[3];
  if (!command || !inputPath) {
    throw new Error("usage: desktop-runner.js <prepare|publish> <input.json>");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result =
    command === "prepare"
      ? await prepare(input, { onProgress: writeProgress })
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

module.exports = { prepare, publish, summarizePreparedRun, explainFailure };
