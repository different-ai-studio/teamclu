"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { git, headCommit } = require("./git-store");
const { zipStore, unzip } = require("./zip");

const CHECKPOINT_SCHEMA_VERSION = 1;
const ENTRY_NAMES = [
  "manifest.json",
  "config.json",
  "state.json",
  "wiki.bundle",
  "prepared-run.json",
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertCleanWiki(wikiRoot) {
  const status = git(wikiRoot, ["status", "--porcelain"]);
  if (status) throw new Error("cannot checkpoint a dirty wiki worktree");
}

function createGitBundle(wikiRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-checkpoint-bundle-"));
  const bundlePath = path.join(dir, "wiki.bundle");
  try {
    execFileSync("git", ["bundle", "create", bundlePath, "HEAD"], {
      cwd: wikiRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return fs.readFileSync(bundlePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertCheckpointTextSafe(label, bytes) {
  const text = bytes.toString("utf8");
  if (
    text.includes("BEGIN PRIVATE KEY") ||
    text.includes("BEGIN OPENSSH PRIVATE KEY") ||
    /sk-[A-Za-z0-9]{12,}/.test(text) ||
    /AKIA[0-9A-Z]{16}/.test(text)
  ) {
    throw new Error(`checkpoint ${label} contains a credential`);
  }
  if (text.includes("pi-transcript") || text.includes('"type":"session"')) {
    throw new Error(`checkpoint ${label} contains a model transcript`);
  }
  if (text.includes("state/raw/") || text.includes('"/raw/')) {
    throw new Error(`checkpoint ${label} contains raw source cache`);
  }
  // Git bundles are binary packs. Their metadata can mention a machine path
  // without that path being checkpoint configuration, so only the JSON entries
  // are rejected for local absolute paths.
  if (label === "wiki.bundle") return;
  if (text.includes("/Users/") || text.includes("/home/") || /[A-Za-z]:\\Users/.test(text)) {
    throw new Error(`checkpoint ${label} contains a local absolute path`);
  }
}

function createCheckpoint(opts) {
  const wikiRoot = path.join(opts.workRoot, "wiki");
  const configPath = opts.configPath || path.join(opts.workRoot, "config.json");
  const statePath = path.join(opts.workRoot, "state", "state.json");
  if (!fs.existsSync(configPath)) throw new Error("checkpoint config.json is missing");
  if (!fs.existsSync(statePath)) throw new Error("checkpoint state.json is missing");
  assertCleanWiki(wikiRoot);

  const stateBytes = fs.readFileSync(statePath);
  const configBytes = fs.readFileSync(configPath);
  const bundleBytes = createGitBundle(wikiRoot);
  const preparedBytes = jsonBytes(opts.preparedRun || {});
  const manifest = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    teamId: opts.teamId,
    generation: opts.generation,
    parentGeneration: opts.parentGeneration,
    configVersion: opts.configVersion,
    nodeId: opts.nodeId,
    compilerModel: opts.compilerModel,
    wikiHead: headCommit(wikiRoot),
    publishedCommit: JSON.parse(stateBytes.toString("utf8")).publishedCommit ?? null,
    readyToPublish: opts.readyToPublish === true,
    baseline: opts.baseline === true,
    targetCommit: opts.readyToPublish ? opts.preparedRun?.targetCommit : null,
    targetTreeHash: opts.readyToPublish ? opts.preparedRun?.targetTreeHash : null,
    baseTreeHash: opts.readyToPublish ? (opts.preparedRun?.baseTreeHash ?? null) : null,
    createdAt: new Date().toISOString(),
    entries: {
      "config.json": { size: configBytes.length, sha256: sha256(configBytes) },
      "state.json": { size: stateBytes.length, sha256: sha256(stateBytes) },
      "wiki.bundle": { size: bundleBytes.length, sha256: sha256(bundleBytes) },
      "prepared-run.json": {
        size: preparedBytes.length,
        sha256: sha256(preparedBytes),
      },
    },
  };
  for (const [label, data] of [
    ["config.json", configBytes],
    ["state.json", stateBytes],
    ["prepared-run.json", preparedBytes],
    ["wiki.bundle", bundleBytes],
  ]) {
    assertCheckpointTextSafe(label, data);
  }
  const bytes = zipStore([
    { name: "manifest.json", data: jsonBytes(manifest) },
    { name: "config.json", data: configBytes },
    { name: "state.json", data: stateBytes },
    { name: "wiki.bundle", data: bundleBytes },
    { name: "prepared-run.json", data: preparedBytes },
  ]);
  return { bytes, size: bytes.length, sha256: sha256(bytes), manifest };
}

function parseCheckpoint(bytes) {
  const files = unzip(bytes);
  const names = [...files.keys()].sort();
  if (
    names.length !== ENTRY_NAMES.length ||
    names.some((name, index) => name !== [...ENTRY_NAMES].sort()[index])
  ) {
    throw new Error("checkpoint contains unexpected files");
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  } catch {
    throw new Error("checkpoint manifest is invalid");
  }
  if (manifest.schemaVersion > CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("Upgrade TeamClu to restore this Wiki checkpoint.");
  }
  if (manifest.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("unsupported checkpoint schema version");
  }
  for (const name of ENTRY_NAMES) {
    assertCheckpointTextSafe(name, files.get(name));
  }
  for (const name of ENTRY_NAMES.filter((entry) => entry !== "manifest.json")) {
    const entry = manifest.entries?.[name];
    const data = files.get(name);
    if (
      !entry ||
      entry.size !== data.length ||
      typeof entry.sha256 !== "string" ||
      entry.sha256 !== sha256(data)
    ) {
      throw new Error(`checkpoint manifest hash mismatch: ${name}`);
    }
  }
  return { files, manifest };
}

function cloneBundle(bundleBytes, destination, expectedHead) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-checkpoint-restore-"));
  const bundlePath = path.join(temp, "wiki.bundle");
  try {
    fs.writeFileSync(bundlePath, bundleBytes);
    execFileSync("git", ["clone", "--quiet", bundlePath, destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      execFileSync("git", ["cat-file", "-e", `${expectedHead}^{commit}`], {
        cwd: destination,
        stdio: "ignore",
      });
      execFileSync("git", ["reset", "--hard", expectedHead], {
        cwd: destination,
        stdio: "ignore",
      });
    } catch {
      throw new Error("checkpoint wiki head mismatch");
    }
    if (headCommit(destination) !== expectedHead) {
      throw new Error("checkpoint wiki head mismatch");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function replaceWiki(workRoot, nextWiki) {
  const wikiRoot = path.join(workRoot, "wiki");
  const backup = path.join(
    workRoot,
    `.wiki-backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const hadWiki = fs.existsSync(wikiRoot);
  if (hadWiki) fs.renameSync(wikiRoot, backup);
  try {
    fs.renameSync(nextWiki, wikiRoot);
    if (hadWiki) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(wikiRoot)) {
      fs.rmSync(wikiRoot, { recursive: true, force: true });
    }
    if (hadWiki && fs.existsSync(backup)) fs.renameSync(backup, wikiRoot);
    throw error;
  }
}

function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, filePath);
}

function restoreCheckpoint(opts) {
  const { files, manifest } = parseCheckpoint(opts.bytes);
  if (opts.expectedTeamId && manifest.teamId !== opts.expectedTeamId) {
    throw new Error("checkpoint belongs to another team");
  }
  fs.mkdirSync(opts.workRoot, { recursive: true });
  const nextWiki = path.join(
    opts.workRoot,
    `.wiki-restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    cloneBundle(files.get("wiki.bundle"), nextWiki, manifest.wikiHead);
    replaceWiki(opts.workRoot, nextWiki);
    atomicWrite(
      path.join(opts.workRoot, "config.json"),
      files.get("config.json"),
    );
    let stateBytes = files.get("state.json");
    if (Object.prototype.hasOwnProperty.call(opts, "publishedCommit")) {
      if (
        opts.publishedCommit !== null &&
        (typeof opts.publishedCommit !== "string" ||
          !/^[0-9a-f]{40}$/i.test(opts.publishedCommit))
      ) {
        throw new Error("checkpoint publishedCommit must be a 40-character git commit");
      }
      const state = JSON.parse(stateBytes.toString("utf8"));
      state.publishedCommit = opts.publishedCommit?.toLowerCase() ?? null;
      stateBytes = jsonBytes(state);
    }
    atomicWrite(path.join(opts.workRoot, "state", "state.json"), stateBytes);
    atomicWrite(
      path.join(opts.workRoot, "state", "prepared-run.json"),
      files.get("prepared-run.json"),
    );
  } finally {
    if (fs.existsSync(nextWiki)) {
      fs.rmSync(nextWiki, { recursive: true, force: true });
    }
  }
  return manifest;
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  createCheckpoint,
  parseCheckpoint,
  restoreCheckpoint,
};
