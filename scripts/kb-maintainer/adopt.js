"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter } = require("./frontmatter");
const { commitAll, ensureWikiRepo, headCommit } = require("./git-store");
const { saveState } = require("./ingest");
const { createCheckpoint } = require("./checkpoint");

function listMarkdown(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name.startsWith(".")) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.name.endsWith(".md")) out.push(abs);
    }
  }
  return out.sort();
}

function pageProblems(vaultWiki) {
  const problems = [];
  for (const file of listMarkdown(vaultWiki)) {
    const rel = path.relative(vaultWiki, file).split(path.sep).join("/");
    if (rel === "index.md") continue;
    try {
      const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
      const sources = parsed.frontmatter?.sources;
      if (!Array.isArray(sources) || sources.length === 0) {
        problems.push(rel);
      }
    } catch {
      problems.push(rel);
    }
  }
  return problems;
}

function inspectExistingWiki(knowledgeRoot) {
  const vaultWiki = path.join(knowledgeRoot, "wiki");
  const pages = listMarkdown(vaultWiki).map((file) =>
    path.relative(vaultWiki, file).split(path.sep).join("/"),
  );
  return {
    needsAdopt: pages.some((rel) => rel !== "index.md"),
    problems: pageProblems(vaultWiki),
  };
}

function adoptExistingWiki(opts) {
  const vaultWiki = path.join(opts.knowledgeRoot, "wiki");
  const inspection = inspectExistingWiki(opts.knowledgeRoot);
  if (!inspection.needsAdopt) {
    throw new Error("knowledge/wiki has no published pages to adopt");
  }
  if (inspection.problems.length > 0) {
    throw new Error(`Wiki pages are missing sources: ${inspection.problems.join(", ")}`);
  }
  const wikiRoot = path.join(opts.workRoot, "wiki");
  ensureWikiRepo(wikiRoot);
  for (const file of listMarkdown(vaultWiki)) {
    const rel = path.relative(vaultWiki, file);
    const dest = path.join(wikiRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }
  const adoptedCommit = commitAll(wikiRoot, "wiki: adopt the published team vault");
  saveState(path.join(opts.workRoot, "state", "state.json"), {
    schemaVersion: 1,
    teamId: opts.teamId,
    sources: {},
    publishedCommit: adoptedCommit,
  });
  const generation = opts.expectedGeneration + 1;
  const out = createCheckpoint({
    workRoot: opts.workRoot,
    configPath: opts.configPath,
    teamId: opts.teamId,
    generation,
    parentGeneration: opts.expectedGeneration,
    configVersion: opts.configVersion,
    nodeId: opts.nodeId,
    compilerModel: opts.compilerModel || "default",
    preparedRun: { status: "adopted", targetCommit: adoptedCommit },
    readyToPublish: false,
    baseline: true,
  });
  const directory = path.join(opts.workRoot, "state", "checkpoints");
  fs.mkdirSync(directory, { recursive: true });
  const checkpointPath = path.join(directory, `${generation}-${out.sha256}.zip`);
  fs.writeFileSync(checkpointPath, out.bytes);
  return {
    adoptedCommit,
    wikiHead: headCommit(wikiRoot),
    expectedGeneration: opts.expectedGeneration,
    configVersion: opts.configVersion,
    checkpointPath,
    sha256: out.sha256,
    size: out.size,
    manifest: out.manifest,
  };
}

module.exports = { inspectExistingWiki, adoptExistingWiki };
