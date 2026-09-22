#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dryRun } = require("./dry-run");
const { ingestBatch, loadState } = require("./ingest");
const { publishWiki } = require("./publish");
const { estimateVision } = require("./estimate");
const { lintBatch } = require("./lint");
const { loadEvalSet, scoreEval, meetsPilotThreshold } = require("./eval-set");
const { loadConfig } = require("./config");
const { createDaemonSync } = require("./sync-adapter");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(name);
}

function readJson(filePath, fallback) {
  if (!filePath) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function commonOpts() {
  const aclPath = arg("--acl-json");
  return {
    configPath: arg("--config"),
    statePath: arg("--state"),
    documentsRoot: arg("--documents-root"),
    knowledgeRoot: arg("--knowledge-root"),
    nodeId: arg("--node-id"),
    known: readJson(arg("--known-json"), []),
    aclPrefixes: aclPath ? readJson(aclPath, null) : null,
    workRoot: arg("--work-root"),
    runner: arg("--runner", "fake"),
    acceptVisionEstimate: flag("--accept-vision-estimate"),
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "dry-run") {
    print(dryRun(commonOpts()));
    return;
  }
  if (command === "estimate") {
    print(await estimateVision(commonOpts()));
    return;
  }
  if (command === "ingest") {
    const opts = commonOpts();
    if (opts.acceptVisionEstimate) {
      process.stderr.write("vision ingest is not wired; pass a visionExtract hook in tests only\n");
    }
    const result = await ingestBatch(opts);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "lint") {
    const opts = commonOpts();
    const report = lintBatch({
      wikiRoot: path.join(opts.workRoot, "wiki"),
      state: loadState(opts.statePath),
      config: loadConfig(opts.configPath),
    });
    print(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === "eval") {
    const opts = commonOpts();
    const questions = loadEvalSet(arg("--eval-json"));
    const report = scoreEval({
      wikiRoot: path.join(opts.workRoot, "wiki"),
      questions,
    });
    print({ ...report, meetsPilotThreshold: meetsPilotThreshold(report) });
    process.exitCode = meetsPilotThreshold(report) ? 0 : 1;
    return;
  }
  if (command === "publish") {
    const opts = commonOpts();
    const lint = lintBatch({
      wikiRoot: path.join(opts.workRoot, "wiki"),
      state: loadState(opts.statePath),
      config: opts.configPath ? loadConfig(opts.configPath) : { limits: {} },
    });
    if (!lint.ok) {
      print({ ok: false, stage: "lint", lint });
      process.exitCode = 1;
      return;
    }
    const result = await publishWiki({
      wikiRoot: path.join(opts.workRoot, "wiki"),
      knowledgeRoot: opts.knowledgeRoot,
      statePath: opts.statePath,
      workRoot: opts.workRoot,
      syncTeam: createDaemonSync({
        baseUrl: arg("--daemon-url"),
        token: arg("--daemon-token"),
      }),
    });
    print({ ...result, lint });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  process.stderr.write(
    "usage: node scripts/kb-maintainer/cli.js <dry-run|estimate|ingest|lint|eval|publish> --config <config.json> ...\n",
  );
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
