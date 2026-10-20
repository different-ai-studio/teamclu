"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const { isRestrictedPath, restrictedDocumentPrefixes } = require("./acl-preflight");
const { classifySource } = require("./whitelist");
const { reconcile } = require("./reconcile");
const { normalizeDocumentsPath } = require("./paths");

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function toDocumentsPath(documentsRoot, absPath) {
  const rel = path.relative(documentsRoot, absPath).split(path.sep).join("/");
  return normalizeDocumentsPath(`documents/${rel}`);
}

function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return { schemaVersion: 1, sources: {} };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function assertSchema(knowledgeRoot) {
  const schemaPath = path.join(knowledgeRoot, "_schema.md");
  if (!fs.existsSync(schemaPath)) {
    throw new Error("knowledge/_schema.md is missing");
  }
  const text = fs.readFileSync(schemaPath, "utf8").trim();
  if (text.length === 0) {
    throw new Error("knowledge/_schema.md is empty");
  }
}

function dryRun(opts) {
  const config = loadConfig(opts.configPath);
  if (typeof opts.fetchDocuments === "function") {
    // Slice 1 must never fetch; presence of the hook is a tripwire for tests.
  }
  if (typeof opts.runAgent === "function") {
    // Same: dry-run must not invoke it.
  }

  const restrictedPrefixes = restrictedDocumentPrefixes(opts.aclPrefixes);
  const restricted = (documentsPath) => isRestrictedPath(documentsPath, restrictedPrefixes);
  assertSchema(opts.knowledgeRoot);

  const state = loadState(opts.statePath);
  const importedSources =
    state.sources && typeof state.sources === "object" ? state.sources : {};

  const restrictedPaths = new Set();
  const localByPath = new Map();
  for (const abs of walkFiles(opts.documentsRoot)) {
    const documentsPath = toDocumentsPath(opts.documentsRoot, abs);
    if (restricted(documentsPath)) {
      restrictedPaths.add(documentsPath);
      continue;
    }
    const stat = fs.statSync(abs);
    localByPath.set(documentsPath, {
      path: documentsPath,
      size: stat.size,
      sourceSha256: sha256File(abs),
      local: true,
    });
  }

  const known = Array.isArray(opts.known) ? opts.known : [];
  const knownPaths = [];
  const union = new Map(localByPath);
  for (const item of known) {
    const documentsPath = normalizeDocumentsPath(item.path);
    if (restricted(documentsPath)) {
      restrictedPaths.add(documentsPath);
      continue;
    }
    knownPaths.push(documentsPath);
    if (union.has(documentsPath)) continue;
    // Listed by the team but not downloaded. Missing from disk is not a delete.
    union.set(documentsPath, {
      path: documentsPath,
      size: Number(item.size) || 0,
      local: false,
    });
  }

  const allowed = [];
  const denied = [];
  const blocked = [];
  const ignored = [];
  const retained = [];
  for (const item of [...union.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const verdict = classifySource(item, config);
    if (verdict.status === "allowed") {
      allowed.push({ ...item, class: verdict.class, priority: verdict.priority });
    } else if (verdict.status === "denied") {
      denied.push(verdict);
    } else if (verdict.status === "ignored") {
      ignored.push(verdict);
      // A folder left unchecked still has its files. That is not a deletion.
      if (item.local !== false && importedSources[item.path]) {
        retained.push(item.path);
      }
    } else {
      blocked.push(verdict);
    }
  }
  const queues = reconcile({
    current: allowed,
    state,
    retain: [...retained, ...knownPaths],
  });
  // Imported sources that are now restricted leave the wiki through `restrict`,
  // which never hands their text to the model.
  const restrict = Object.keys(importedSources)
    .filter(restricted)
    .sort()
    .map((sourcePath) => ({
      path: sourcePath,
      sourceSha256: importedSources[sourcePath].sourceSha256,
    }));
  const plan = {
    restrict,
    add: queues.add,
    update: queues.update,
    delete: queues.delete.filter((item) => !restricted(item.path)),
    unchanged: queues.unchanged,
    would_fetch: queues.would_fetch,
    denied,
    blocked,
    ignored,
  };

  return {
    ok: true,
    teamId: config.teamId,
    restrictedPrefixes,
    counts: {
      restrict: plan.restrict.length,
      restricted: restrictedPaths.size,
      add: plan.add.length,
      update: plan.update.length,
      delete: plan.delete.length,
      unchanged: plan.unchanged.length,
      would_fetch: plan.would_fetch.length,
      denied: plan.denied.length,
      blocked: plan.blocked.length,
      ignored: plan.ignored.length,
    },
    plan,
  };
}

module.exports = { dryRun, sha256File };
