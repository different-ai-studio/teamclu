"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const { assertDocumentsAclAllowsPublish } = require("./acl-preflight");
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
  if (opts.nodeId !== config.maintainerNodeId) {
    throw new Error(`maintainer node id mismatch: expected ${config.maintainerNodeId}`);
  }
  if (typeof opts.fetchDocuments === "function") {
    // Slice 1 must never fetch; presence of the hook is a tripwire for tests.
  }
  if (typeof opts.runAgent === "function") {
    // Same: dry-run must not invoke it.
  }

  assertDocumentsAclAllowsPublish({
    whitelistPrefixes: config.sources.map((source) => source.prefix),
    aclPrefixes: opts.aclPrefixes,
  });
  assertSchema(opts.knowledgeRoot);

  const localByPath = new Map();
  for (const abs of walkFiles(opts.documentsRoot)) {
    const documentsPath = toDocumentsPath(opts.documentsRoot, abs);
    const stat = fs.statSync(abs);
    localByPath.set(documentsPath, {
      path: documentsPath,
      size: stat.size,
      sourceSha256: sha256File(abs),
      local: true,
    });
  }

  const known = Array.isArray(opts.known) ? opts.known : [];
  const union = new Map(localByPath);
  for (const item of known) {
    const documentsPath = normalizeDocumentsPath(item.path);
    if (!union.has(documentsPath)) {
      union.set(documentsPath, {
        path: documentsPath,
        size: Number(item.size) || 0,
        local: false,
      });
    }
  }

  const allowed = [];
  const denied = [];
  const blocked = [];
  const ignored = [];
  for (const item of [...union.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const verdict = classifySource(item, config);
    if (verdict.status === "allowed") {
      allowed.push({ ...item, class: verdict.class, priority: verdict.priority });
    } else if (verdict.status === "denied") {
      denied.push(verdict);
    } else if (verdict.status === "ignored") {
      ignored.push(verdict);
    } else {
      blocked.push(verdict);
    }
  }

  const state = loadState(opts.statePath);
  const queues = reconcile({ current: allowed, state });
  const plan = {
    add: queues.add,
    update: queues.update,
    delete: queues.delete,
    unchanged: queues.unchanged,
    would_fetch: queues.would_fetch,
    denied,
    blocked,
    ignored,
  };

  return {
    ok: true,
    teamId: config.teamId,
    counts: {
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
