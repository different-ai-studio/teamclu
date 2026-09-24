"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { git, gitShow, headCommit, commitAll } = require("./git-store");
const { parseFrontmatter } = require("./frontmatter");
const { normalizeDocumentsPath } = require("./paths");
const { isAllowedWikiPath, rebuildIndex } = require("./validator");
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
    baseTreeHash: fromCommit ? treeHashFromCommit(wikiRoot, fromCommit) : null,
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

function documentsRootFor(opts) {
  if (opts.documentsRoot) return opts.documentsRoot;
  if (!opts.knowledgeRoot) return null;
  return path.join(path.dirname(opts.knowledgeRoot), "documents");
}

function sourceStillOnDisk(documentsRoot, sourcePath) {
  if (!documentsRoot || typeof sourcePath !== "string" || !sourcePath.startsWith("documents/")) {
    return false;
  }
  const rel = sourcePath.slice("documents/".length);
  if (!rel || rel.split("/").includes("..")) return false;
  return fs.existsSync(path.join(documentsRoot, rel));
}

function knownPathSet(known) {
  const set = new Set();
  for (const item of known || []) {
    if (!item || typeof item.path !== "string") continue;
    try {
      set.add(normalizeDocumentsPath(item.path));
    } catch {
      continue;
    }
  }
  return set;
}

function sourceStillExists(documentsRoot, sourcePath, knownPaths) {
  if (sourceStillOnDisk(documentsRoot, sourcePath)) return true;
  return knownPaths.has(sourcePath);
}

function pageStillHasSource(bytes, documentsRoot, knownPaths) {
  let parsed;
  try {
    parsed = parseFrontmatter(bytes.toString("utf8"));
  } catch {
    return false;
  }
  const sources = parsed.frontmatter?.sources;
  if (!Array.isArray(sources)) return false;
  return sources.some((source) =>
    sourceStillExists(documentsRoot, source && source.path, knownPaths),
  );
}

function writeTreeFromDirectory(wikiRoot, dir, rels) {
  const indexFile = path.join(
    os.tmpdir(),
    `kb-vault-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const run = (args) =>
    execFileSync("git", ["-C", wikiRoot, "-c", "core.quotepath=false", ...args], {
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      encoding: "utf8",
    }).trim();
  try {
    run(["read-tree", "--empty"]);
    for (const rel of rels) {
      const blob = run(["hash-object", "-w", path.join(dir, rel)]);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`]);
    }
    return run(["write-tree"]);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

function rememberVaultSources(wikiRoot, state) {
  if (!state.sources || typeof state.sources !== "object") state.sources = {};
  const cited = new Map();
  for (const rel of listWikiRelFromDir(wikiRoot)) {
    if (!rel.startsWith("pages/") || !rel.endsWith(".md")) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(path.join(wikiRoot, rel), "utf8"));
    } catch {
      continue;
    }
    const sources = parsed.frontmatter?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!source || typeof source.path !== "string" || !source.sha256) continue;
      const prior = cited.get(source.path) || {
        sourceSha256: source.sha256,
        affectedPages: [],
      };
      if (!prior.affectedPages.includes(rel)) prior.affectedPages.push(rel);
      cited.set(source.path, prior);
    }
  }
  for (const [sourcePath, record] of cited) {
    if (state.sources[sourcePath]) continue;
    state.sources[sourcePath] = {
      sourceSha256: record.sourceSha256,
      affectedPages: record.affectedPages.sort(),
      status: "imported",
    };
  }
}

function compiledPagesPreserved(wikiRoot, nextCommit, compiledCommit) {
  for (const rel of listWikiFilesAtCommit(wikiRoot, compiledCommit)) {
    if (rel === "index.md") continue;
    if (!listWikiFilesAtCommit(wikiRoot, nextCommit).includes(rel)) return false;
    const next = fileAtCommit(wikiRoot, nextCommit, rel);
    const compiled = fileAtCommit(wikiRoot, compiledCommit, rel);
    if (!next.equals(compiled)) return false;
  }
  return true;
}

/** Pages already in the team vault stay when this compile did not include them
 * and their source files are still on disk. The vault snapshot becomes the
 * publish baseline so the new pages are added beside them. */
function absorbPublishedVault(opts) {
  const wikiRoot = opts.wikiRoot;
  const knowledgeRoot = opts.knowledgeRoot;
  const statePath = opts.statePath;
  if (!wikiRoot || !knowledgeRoot || !statePath) return null;
  if (readMarker(opts.workRoot)) return null;
  const state = loadState(statePath);
  if (state.publishedCommit) return null;
  const vault = vaultWikiRoot(knowledgeRoot);
  const documentsRoot = documentsRootFor(opts);
  const knownPaths = knownPathSet(opts.known);
  const head = headCommit(wikiRoot);
  const inHead = new Set(listWikiFilesAtCommit(wikiRoot, head));
  const vaultRels = listWikiRelFromDir(vault);
  const missing = [];
  for (const rel of vaultRels) {
    if (rel === "index.md" || inHead.has(rel)) continue;
    const bytes = fs.readFileSync(path.join(vault, rel));
    if (!pageStillHasSource(bytes, documentsRoot, knownPaths)) continue;
    missing.push(rel);
  }
  if (missing.length === 0) return null;
  const baselineTree = writeTreeFromDirectory(wikiRoot, vault, vaultRels);
  const baseline = git(wikiRoot, [
    "commit-tree",
    baselineTree,
    "-m",
    "wiki: baseline from the published team vault",
  ]);
  for (const rel of missing) {
    const dest = path.join(wikiRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(vault, rel), dest);
  }
  rebuildIndex(wikiRoot);
  const next = commitAll(wikiRoot, "wiki: keep pages already published in the team vault");
  state.publishedCommit = baseline;
  rememberVaultSources(wikiRoot, state);
  saveState(statePath, state);
  return { baseline, next };
}

function assertNoConflicts(knowledgeRoot) {
  const sidecar = path.join(knowledgeRoot, "wiki", ".conflicts");
  if (fs.existsSync(sidecar)) {
    throw new Error("knowledge/wiki has unresolved sync conflicts");
  }
}

function assertVaultBaseline({
  knowledgeRoot,
  wikiRoot,
  publishedCommit,
  targetCommit,
  replaying,
}) {
  if (replaying) return;
  const vault = vaultWikiRoot(knowledgeRoot);
  if (!publishedCommit) {
    const files = listWikiRelFromDir(vault);
    if (files.length === 0 || treeHashFromDir(vault) === treeHashFromCommit(wikiRoot, targetCommit)) {
      return;
    }
    throw new Error("knowledge/wiki has unexplained content; refuse the first publish");
  }
  const expected = treeHashFromCommit(wikiRoot, publishedCommit);
  const actual = treeHashFromDir(vault);
  if (actual === expected) return;
  // A previous publish already wrote this target, or this compile absorbed the
  // vault, while the recorded baseline still points at an older commit.
  if (targetCommit && actual === treeHashFromCommit(wikiRoot, targetCommit)) return;
  throw new Error("knowledge/wiki was modified externally; refuse to overwrite");
}

function assertReplayableVault({ knowledgeRoot, wikiRoot, plan }) {
  const vault = vaultWikiRoot(knowledgeRoot);
  const base = new Set(
    plan.fromCommit ? listWikiFilesAtCommit(wikiRoot, plan.fromCommit) : [],
  );
  const target = new Set(listWikiFilesAtCommit(wikiRoot, plan.toCommit));
  const all = new Set([...base, ...target]);
  for (const rel of listWikiRelFromDir(vault)) {
    if (!all.has(rel)) {
      throw new Error(`knowledge/wiki contains an unexplained file during recovery: ${rel}`);
    }
  }
  for (const rel of all) {
    const dest = resolveInside(vault, rel);
    if (!fs.existsSync(dest)) {
      if (base.has(rel) && target.has(rel)) {
        throw new Error(`knowledge/wiki is missing an unexplained file during recovery: ${rel}`);
      }
      continue;
    }
    const current = fs.readFileSync(dest);
    const matchesBase =
      plan.fromCommit &&
      base.has(rel) &&
      current.equals(fileAtCommit(wikiRoot, plan.fromCommit, rel));
    const matchesTarget =
      target.has(rel) && current.equals(fileAtCommit(wikiRoot, plan.toCommit, rel));
    if (!matchesBase && !matchesTarget) {
      throw new Error(`knowledge/wiki has unexplained content during recovery: ${rel}`);
    }
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
  const absorbed = absorbPublishedVault(opts);
  const state = loadState(opts.statePath);
  const toCommit = headCommit(wikiRoot);
  const marker = readMarker(workRoot);
  const replaying = Boolean(marker || opts.forceReplay);
  if (marker && marker.toCommit !== toCommit) {
    throw new Error(`incomplete publish for ${marker.toCommit} must be replayed before publishing ${toCommit}`);
  }
  const plan =
    opts.planOverride ||
    buildPublishPlan({
      wikiRoot,
      fromCommit: state.publishedCommit || null,
      toCommit,
    });
  assertNoConflicts(knowledgeRoot);
  assertVaultBaseline({
    knowledgeRoot,
    wikiRoot,
    publishedCommit: state.publishedCommit,
    targetCommit: plan.toCommit,
    replaying,
  });
  if (
    opts.expectedTargetCommit &&
    (plan.toCommit !== opts.expectedTargetCommit ||
      plan.targetTreeHash !== opts.expectedTargetTreeHash ||
      (plan.baseTreeHash ?? null) !== (opts.expectedBaseTreeHash ?? null))
  ) {
    const keptCompiledPages =
      absorbed &&
      compiledPagesPreserved(wikiRoot, plan.toCommit, opts.expectedTargetCommit);
    if (!keptCompiledPages) {
      throw new Error("local Wiki publish target does not match the cloud checkpoint");
    }
  }
  if (replaying) {
    assertReplayableVault({ knowledgeRoot, wikiRoot, plan });
  }
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
