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
const { createCheckpoint, restoreCheckpoint } = require("./checkpoint");

const SKIPPED =
  "This source was skipped this run and will be compiled again next time.";
const NO_PAGES = "The compiler did not write a Wiki page for this source.";

function explainFailure(error) {
  const text = String(error || "");
  if (/compiler produced no wiki pages/.test(text)) {
    return NO_PAGES;
  }
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
    /dead wiki link|did not retract|PII|internal leak|copy ratio|illegal type|unreadable frontmatter|managed_by|schema_version|sha256 mismatch|locator not in raw|exceeds \d+ chars|source-summary too large|index summary mismatch|index missing|index repeats|index points|changed \d+ pages|diff escapes|link not allowed|missing frontmatter|unterminated frontmatter|sources required|quality check failed|source not in current set|wiki\/index\.md is missing|path escapes|raw cache missing/.test(
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
    baseTreeHash: publishPlan.baseTreeHash ?? null,
    targetCommit: publishPlan.toCommit,
    targetTreeHash: publishPlan.targetTreeHash,
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
  const onCheckpoint =
    typeof hooks.onCheckpoint === "function" ? hooks.onCheckpoint : null;
  let generation = Number.isSafeInteger(input.expectedGeneration)
    ? input.expectedGeneration
    : 0;
  const configVersion = Number.isSafeInteger(input.configVersion)
    ? input.configVersion
    : 1;
  const checkpoint = async (preparedRun, readyToPublish) => {
    if (!onCheckpoint) return;
    fs.writeFileSync(
      path.join(input.workRoot, "state", "prepared-run.json"),
      `${JSON.stringify(preparedRun, null, 2)}\n`,
    );
    const expectedGeneration = generation;
    generation += 1;
    const out = createCheckpoint({
      workRoot: input.workRoot,
      configPath: input.configPath,
      teamId: loadConfig(input.configPath).teamId,
      generation,
      parentGeneration: expectedGeneration,
      configVersion,
      nodeId: input.nodeId,
      compilerModel: input.compilerModel || "default",
      preparedRun,
      readyToPublish,
    });
    const directory = path.join(input.workRoot, "state", "checkpoints");
    fs.mkdirSync(directory, { recursive: true });
    const checkpointPath = path.join(directory, `${generation}-${out.sha256}.zip`);
    if (!fs.existsSync(checkpointPath)) fs.writeFileSync(checkpointPath, out.bytes);
    await onCheckpoint({
      expectedGeneration,
      configVersion,
      checkpointPath,
      sha256: out.sha256,
      size: out.size,
      manifest: out.manifest,
      preparedRun,
    });
  };
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
    cancelPath: path.join(input.workRoot, "state", "cancel-requested"),
    acceptVisionEstimate: false,
    createSession: input.createSession,
    onProgress,
    onCheckpoint: async (source) =>
      checkpoint(
        {
          runId: input.runId,
          status: "compiling",
          lastSource: source,
        },
        false,
      ),
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
  const summary = summarizePreparedRun({
    runId: input.runId,
    plan: dry.plan,
    ingest,
    lint,
    estimate,
    publishPlan,
  });
  summary.nodeId = input.nodeId;
  await checkpoint(summary, summary.canPublish);
  onProgress({ stage: "done" });
  return summary;
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
    documentsRoot: input.documentsRoot,
    statePath: input.statePath,
    workRoot: input.workRoot,
    forceReplay: input.cloudPublishingRecovery === true,
    expectedTargetCommit: input.expectedTargetCommit,
    expectedTargetTreeHash: input.expectedTargetTreeHash,
    expectedBaseTreeHash: input.expectedBaseTreeHash,
  });
}

const { writeProgress } = require("./progress");
const { adoptExistingWiki, inspectExistingWiki } = require("./adopt");

function writeCheckpointPackage(input, out) {
  const directory = path.join(input.workRoot, "state", "checkpoints");
  fs.mkdirSync(directory, { recursive: true });
  const checkpointPath = path.join(
    directory,
    `${out.manifest.generation}-${out.sha256}.zip`,
  );
  fs.writeFileSync(checkpointPath, out.bytes);
  fs.writeFileSync(
    path.join(input.workRoot, "state", "checkpoint-manifest.json"),
    `${JSON.stringify(out.manifest, null, 2)}\n`,
  );
  return {
    expectedGeneration: out.manifest.parentGeneration,
    configVersion: out.manifest.configVersion,
    checkpointPath,
    sha256: out.sha256,
    size: out.size,
    manifest: out.manifest,
  };
}

function createBaseline(input) {
  const generation = input.expectedGeneration + 1;
  return writeCheckpointPackage(
    input,
    createCheckpoint({
      workRoot: input.workRoot,
      configPath: input.configPath,
      teamId: loadConfig(input.configPath).teamId,
      generation,
      parentGeneration: input.expectedGeneration,
      configVersion: input.configVersion,
      nodeId: input.nodeId,
      compilerModel: input.compilerModel || "default",
      preparedRun: { status: "published" },
      readyToPublish: false,
      baseline: true,
    }),
  );
}

function checkpointAckPath(input, generation) {
  return path.join(input.workRoot, "state", `checkpoint-ack-${generation}.json`);
}

async function publishCheckpointAndWait(input, checkpoint) {
  const ackPath = checkpointAckPath(input, checkpoint.manifest.generation);
  if (fs.existsSync(ackPath)) fs.rmSync(ackPath);
  writeProgress({ stage: "checkpoint", ...checkpoint });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(ackPath)) {
      const ack = JSON.parse(fs.readFileSync(ackPath, "utf8"));
      fs.rmSync(ackPath, { force: true });
      if (ack.accepted === true) return;
      throw new Error("checkpoint generation conflict");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("checkpoint upload acknowledgement timed out");
}

function restore(input) {
  const bytes = fs.readFileSync(input.checkpointPath);
  const manifest = restoreCheckpoint({
    workRoot: input.workRoot,
    bytes,
    expectedTeamId: input.teamId,
    publishedCommit: input.publishedCommit,
  });
  fs.writeFileSync(
    path.join(input.workRoot, "state", "checkpoint-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const command = process.argv[2];
  const inputPath = process.argv[3];
  if (!command || !inputPath) {
    throw new Error(
      "usage: desktop-runner.js <prepare|publish|restore|baseline|adopt|inspect-vault> <input.json>",
    );
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result =
    command === "prepare"
      ? await prepare(input, {
          onProgress: writeProgress,
          onCheckpoint: (checkpoint) => publishCheckpointAndWait(input, checkpoint),
        })
      : command === "publish"
        ? await publish(input)
        : command === "restore"
          ? restore(input)
          : command === "baseline"
            ? createBaseline(input)
            : command === "adopt"
              ? adoptExistingWiki(input)
              : command === "inspect-vault"
                ? inspectExistingWiki(input.knowledgeRoot)
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

module.exports = {
  prepare,
  publish,
  restore,
  publishCheckpointAndWait,
  summarizePreparedRun,
  explainFailure,
};
