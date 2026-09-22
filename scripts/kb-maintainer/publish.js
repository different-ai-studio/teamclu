"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { git, gitShow, headCommit } = require("./git-store");
const { isAllowedWikiPath } = require("./validator");
const { loadState, saveState } = require("./ingest");

const SYNC_OPTIONS = Object.freeze({
  force_sync: true,
  allow_bulk_add: false,
  allow_bulk_delete: false,
});

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function markerPath(workRoot) {
  return path.join(workRoot, "state", "publish-incomplete.json");
}

function vaultWikiRoot(knowledgeRoot) {
  return path.join(knowledgeRoot, "wiki");
}

function assertSafeRel(rel) {
  if (typeof rel !== "string" || !isAllowedWikiPath(rel)) {
    throw new Error(`illegal wiki path escape: ${rel}`);
  }
}

function resolveInside(root, rel) {
  assertSafeRel(rel);
  const base = path.resolve(root);
  const dest = path.resolve(root, rel);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (dest !== base && !dest.startsWith(prefix)) {
    throw new Error(`illegal wiki path escape: ${rel}`);
  }
  return dest;
}

function listWikiFilesAtCommit(wikiRoot, commit) {
  const out = git(wikiRoot, ["ls-tree", "-r", "--name-only", commit]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isAllowedWikiPath)
    .sort();
}

function fileAtCommit(wikiRoot, commit, rel) {
  return gitShow(wikiRoot, commit, rel);
}

function hashEntries(entries) {
  const lines = [...entries]
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map((entry) => `${entry.rel}\0${entry.hash}`)
    .join("\n");
  return sha256Bytes(lines);
}

function treeHashFromCommit(wikiRoot, commit) {
  const files = listWikiFilesAtCommit(wikiRoot, commit);
  return hashEntries(
    files.map((rel) => ({
      rel,
      hash: sha256Bytes(fileAtCommit(wikiRoot, commit, rel)),
    })),
  );
}

function listWikiRelFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name.startsWith(".tmp-")) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (isAllowedWikiPath(rel)) out.push(rel);
    }
  }
  return out.sort();
}

function treeHashFromDir(dir) {
  return hashEntries(
    listWikiRelFromDir(dir).map((rel) => ({
      rel,
      hash: sha256Bytes(fs.readFileSync(path.join(dir, rel))),
    })),
  );
}

function diffStatus(wikiRoot, fromCommit, toCommit) {
  if (!fromCommit) {
    return listWikiFilesAtCommit(wikiRoot, toCommit).map((rel) => ({ status: "A", rel }));
  }
  const out = git(wikiRoot, ["diff", "--name-status", fromCommit, toCommit]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const rel = rest[rest.length - 1];
      return { status: status[0], rel };
    })
    .filter((item) => isAllowedWikiPath(item.rel));
}

function buildPublishPlan({ wikiRoot, fromCommit, toCommit }) {
  const rows = diffStatus(wikiRoot, fromCommit, toCommit);
  const create = [];
  const update = [];
  const del = [];
  for (const row of rows) {
    if (row.status === "A") create.push(row.rel);
    else if (row.status === "M") update.push(row.rel);
    else if (row.status === "D") del.push(row.rel);
    else throw new Error(`unsupported git status ${row.status} for ${row.rel}`);
  }
  create.sort();
  update.sort();
  del.sort();
  return {
    fromCommit: fromCommit || null,
    toCommit,
    create,
    update,
    delete: del,
    targetTreeHash: treeHashFromCommit(wikiRoot, toCommit),
  };
}

function atomicWrite(destAbs, bytes) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const tmp = path.join(
    path.dirname(destAbs),
    `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, destAbs);
}

function writeMarker(workRoot, payload) {
  const file = markerPath(workRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function readMarker(workRoot) {
  const file = markerPath(workRoot);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function clearMarker(workRoot) {
  const file = markerPath(workRoot);
  if (fs.existsSync(file)) fs.rmSync(file);
}

function assertNoConflicts(knowledgeRoot) {
  const sidecar = path.join(knowledgeRoot, "wiki", ".conflicts");
  if (fs.existsSync(sidecar)) {
    throw new Error("knowledge/wiki has unresolved sync conflicts");
  }
}

function assertVaultBaseline({ knowledgeRoot, wikiRoot, publishedCommit, replaying }) {
  if (replaying) return;
  const vault = vaultWikiRoot(knowledgeRoot);
  if (!publishedCommit) {
    // First publish takes over knowledge/wiki/. Leftover pages from earlier
    // experiments are replaced by applyPlan pruning — do not block the run.
    return;
  }
  const expected = treeHashFromCommit(wikiRoot, publishedCommit);
  const actual = treeHashFromDir(vault);
  if (actual !== expected) {
    throw new Error("knowledge/wiki was modified externally; refuse to overwrite");
  }
}

function pruneVaultExtras({ knowledgeRoot, wikiRoot, toCommit }) {
  const vault = vaultWikiRoot(knowledgeRoot);
  const target = new Set(listWikiFilesAtCommit(wikiRoot, toCommit));
  for (const rel of listWikiRelFromDir(vault)) {
    if (target.has(rel)) continue;
    const dest = resolveInside(vault, rel);
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
}

function applyPlan({ wikiRoot, knowledgeRoot, plan, crashAfter }) {
  const vault = vaultWikiRoot(knowledgeRoot);
  fs.mkdirSync(path.join(vault, "pages"), { recursive: true });
  const writes = [...plan.create, ...plan.update].filter((rel) => rel !== "index.md");
  for (const rel of writes) {
    atomicWrite(resolveInside(vault, rel), fileAtCommit(wikiRoot, plan.toCommit, rel));
  }
  if (crashAfter === "pages") {
    throw new Error("injected crash");
  }
  if (
    plan.create.includes("index.md") ||
    plan.update.includes("index.md") ||
    listWikiFilesAtCommit(wikiRoot, plan.toCommit).includes("index.md")
  ) {
    atomicWrite(
      resolveInside(vault, "index.md"),
      fileAtCommit(wikiRoot, plan.toCommit, "index.md"),
    );
  }
  for (const rel of plan.delete) {
    const dest = resolveInside(vault, rel);
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
  pruneVaultExtras({ knowledgeRoot, wikiRoot, toCommit: plan.toCommit });
}

function interpretSync(result) {
  if (!result) return "sync_skipped_no_adapter";
  if (result.blocked_new_files || result.blocked_deletes) return "published_local_sync_pending";
  if (result.ok === false) return "published_local_sync_pending";
  return "synced";
}

async function publishWiki(opts) {
  const wikiRoot = opts.wikiRoot;
  const knowledgeRoot = opts.knowledgeRoot;
  const workRoot = opts.workRoot;
  const state = loadState(opts.statePath);
  const toCommit = headCommit(wikiRoot);
  const marker = readMarker(workRoot);
  const replaying = Boolean(marker);
  if (marker && marker.toCommit !== toCommit) {
    throw new Error(`incomplete publish for ${marker.toCommit} must be replayed before publishing ${toCommit}`);
  }
  assertNoConflicts(knowledgeRoot);
  assertVaultBaseline({
    knowledgeRoot,
    wikiRoot,
    publishedCommit: state.publishedCommit,
    replaying,
  });
  const plan =
    opts.planOverride ||
    buildPublishPlan({
      wikiRoot,
      fromCommit: state.publishedCommit || null,
      toCommit,
    });
  for (const rel of [...plan.create, ...plan.update, ...plan.delete]) {
    assertSafeRel(rel);
  }
  writeMarker(workRoot, { toCommit: plan.toCommit, targetTreeHash: plan.targetTreeHash });
  applyPlan({
    wikiRoot,
    knowledgeRoot,
    plan,
    crashAfter: opts._crashAfter,
  });
  const actual = treeHashFromDir(vaultWikiRoot(knowledgeRoot));
  if (actual !== plan.targetTreeHash) {
    throw new Error("vault tree hash mismatch after publish");
  }
  const syncResult =
    typeof opts.syncTeam === "function"
      ? await opts.syncTeam({ ...SYNC_OPTIONS })
      : { ok: false, error: "sync adapter not configured" };
  const syncStatus = interpretSync(syncResult);
  state.publishedCommit = plan.toCommit;
  state.syncStatus = syncStatus;
  saveState(opts.statePath, state);
  clearMarker(workRoot);
  return { ok: true, plan, syncStatus };
}

module.exports = {
  SYNC_OPTIONS,
  buildPublishPlan,
  publishWiki,
  treeHashFromDir,
  treeHashFromCommit,
};
