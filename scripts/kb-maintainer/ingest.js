"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dryRun } = require("./dry-run");
const { extractorCacheKey, rawRelativePath } = require("./extract-text");
const { extractSource } = require("./extract");
const { compile } = require("./agent-runner");
const { validateSourceDiff } = require("./validator");
const {
  ensureWikiRepo,
  headCommit,
  changedRelPaths,
  commitAll,
  resetHard,
  ingestMessage,
} = require("./git-store");

function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return { schemaVersion: 1, sources: {} };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath);
}

function sourceAbs(documentsRoot, documentsPath) {
  return path.join(documentsRoot, documentsPath.slice("documents/".length));
}

function readOptional(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function sha256String(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function ingestOne({ action, item, opts, config, state, wikiRoot, rawRoot }) {
  const abs = sourceAbs(opts.documentsRoot, item.path);
  const extracted = await extractSource({
    sourcePath: item.path,
    bytes: fs.readFileSync(abs),
    sourceSha256: item.sourceSha256,
    visionExtract: opts.visionExtract,
    visionModel: config.models?.vision,
    promptVersion: config.models?.visionPromptVersion || "v1",
    cache: opts.extractCache,
  });
  if (extracted.quality !== "accepted") {
    throw new Error(`extraction ${extracted.quality}`);
  }
  if (extracted.markdown.replace(/^---[\s\S]*?\n---\n/, "").length > (config.limits.maxExtractedChars || 50000)) {
    throw new Error("too_large");
  }

  const rawRel = rawRelativePath(item.path);
  const rawAbs = path.join(rawRoot, rawRel);
  fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
  fs.writeFileSync(rawAbs, extracted.markdown);

  const beforeCommit = headCommit(wikiRoot);
  const previous = state.sources[item.path] ? { ...state.sources[item.path] } : null;
  state.sources[item.path] = {
    ...(previous || {}),
    pending: { action, sourceSha256: item.sourceSha256, beforeCommit },
  };
  saveState(opts.statePath, state);

  try {
    const compiled = await compile({
      runner: opts.runner || "fake",
      workRoot: opts.workRoot,
      rawRoot,
      action,
      sourcePath: item.path,
      sourceSha256: item.sourceSha256,
      rawMarkdown: extracted.markdown,
      locators: extracted.locators,
      pageType: item.class === "training" ? "training" : item.class,
      affectedPages: previous?.affectedPages,
      schemaMarkdown: readOptional(path.join(opts.knowledgeRoot, "_schema.md")),
      indexMarkdown: readOptional(path.join(wikiRoot, "index.md")),
      compilerModel: opts.compilerModel,
      createSession: opts.createSession,
    });
    const changed = changedRelPaths(wikiRoot, beforeCommit);
    const verdict = validateSourceDiff({
      workRoot: opts.workRoot,
      wikiRoot,
      rawRoot,
      changedRelPaths: changed,
      currentSource: {
        path: item.path,
        sourceSha256: item.sourceSha256,
        rawRelPath: rawRel,
      },
      config,
    });
    if (!verdict.ok) {
      throw new Error(verdict.errors.join("; "));
    }
    const commit = commitAll(wikiRoot, ingestMessage(action, item.path, item.sourceSha256));
    state.sources[item.path] = {
      sourceSha256: item.sourceSha256,
      extractorCacheKey: extractorCacheKey({
        sourceSha256: item.sourceSha256,
        extractorName: extracted.extractorName,
        extractorVersion: extracted.extractorVersion,
      }),
      rawMarkdownSha256: sha256String(extracted.markdown),
      affectedPages: compiled.affectedPages,
      status: "imported",
      lastImportedCommit: commit,
    };
    saveState(opts.statePath, state);
  } catch (error) {
    resetHard(wikiRoot, beforeCommit);
    if (previous && previous.status === "imported") {
      state.sources[item.path] = previous;
    } else {
      delete state.sources[item.path];
    }
    saveState(opts.statePath, state);
    throw error;
  }
}

async function retractOne({ item, opts, config, state, wikiRoot, rawRoot }) {
  const previous = state.sources[item.path];
  if (!previous) return;
  const beforeCommit = headCommit(wikiRoot);
  state.sources[item.path] = {
    ...previous,
    pending: { action: "delete", sourceSha256: previous.sourceSha256, beforeCommit },
  };
  saveState(opts.statePath, state);
  try {
    await compile({
      runner: opts.runner || "fake",
      workRoot: opts.workRoot,
      rawRoot,
      action: "delete",
      sourcePath: item.path,
      sourceSha256: previous.sourceSha256,
      affectedPages: previous.affectedPages,
      schemaMarkdown: readOptional(path.join(opts.knowledgeRoot, "_schema.md")),
      indexMarkdown: readOptional(path.join(wikiRoot, "index.md")),
      compilerModel: opts.compilerModel,
      createSession: opts.createSession,
    });
    const changed = changedRelPaths(wikiRoot, beforeCommit);
    const verdict = validateSourceDiff({
      workRoot: opts.workRoot,
      wikiRoot,
      rawRoot,
      changedRelPaths: changed,
      currentSource: {
        path: item.path,
        sourceSha256: previous.sourceSha256,
        rawRelPath: rawRelativePath(item.path),
      },
      config,
    });
    if (!verdict.ok) {
      throw new Error(verdict.errors.join("; "));
    }
    commitAll(wikiRoot, ingestMessage("delete", item.path, previous.sourceSha256));
    delete state.sources[item.path];
    const rawAbs = path.join(rawRoot, rawRelativePath(item.path));
    if (fs.existsSync(rawAbs)) fs.rmSync(rawAbs);
    saveState(opts.statePath, state);
  } catch (error) {
    resetHard(wikiRoot, beforeCommit);
    state.sources[item.path] = previous;
    saveState(opts.statePath, state);
    throw error;
  }
}

async function ingestBatch(opts) {
  const planResult = dryRun(opts);
  const config = require("./config").loadConfig(opts.configPath);
  const wikiRoot = path.join(opts.workRoot, "wiki");
  const rawRoot = path.join(opts.workRoot, "raw");
  fs.mkdirSync(rawRoot, { recursive: true });
  ensureWikiRepo(wikiRoot);
  const state = loadState(opts.statePath);
  if (!state.sources) state.sources = {};
  const ingestOpts = {
    ...opts,
    visionExtract: opts.acceptVisionEstimate ? opts.visionExtract : undefined,
  };

  const failures = [];
  let imported = 0;
  let rolledBack = 0;
  let retracted = 0;

  for (const item of planResult.plan.add) {
    try {
      await ingestOne({ action: "add", item, opts: ingestOpts, config, state, wikiRoot, rawRoot });
      imported += 1;
    } catch (error) {
      rolledBack += 1;
      failures.push({ path: item.path, action: "add", error: error.message });
    }
  }
  for (const item of planResult.plan.update) {
    try {
      await ingestOne({ action: "update", item, opts: ingestOpts, config, state, wikiRoot, rawRoot });
      imported += 1;
    } catch (error) {
      rolledBack += 1;
      failures.push({ path: item.path, action: "update", error: error.message });
    }
  }
  for (const item of planResult.plan.delete) {
    try {
      await retractOne({ item, opts: ingestOpts, config, state, wikiRoot, rawRoot });
      retracted += 1;
    } catch (error) {
      rolledBack += 1;
      failures.push({ path: item.path, action: "delete", error: error.message });
    }
  }

  return {
    ok: failures.length === 0,
    counts: {
      imported,
      rolled_back: rolledBack,
      retracted,
      unchanged: planResult.plan.unchanged.length,
    },
    failures,
    plan: planResult.plan,
  };
}

module.exports = { ingestBatch, loadState, saveState };
