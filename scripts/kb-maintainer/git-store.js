"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function git(wikiRoot, args) {
  return execFileSync(
    "git",
    ["-c", "user.name=kb-maintainer", "-c", "user.email=kb-maintainer@local", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false", ...args],
    { cwd: wikiRoot, encoding: "utf8" },
  ).trim();
}

function gitShow(wikiRoot, commit, rel) {
  return execFileSync(
    "git",
    ["-c", "core.quotepath=false", "show", `${commit}:${rel}`],
    { cwd: wikiRoot },
  );
}

function ensureWikiRepo(wikiRoot) {
  fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
  const indexPath = path.join(wikiRoot, "index.md");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, "# LLM Wiki\n");
  }
  if (!fs.existsSync(path.join(wikiRoot, ".git"))) {
    git(wikiRoot, ["init"]);
    git(wikiRoot, ["add", "-A"]);
    git(wikiRoot, ["commit", "--allow-empty", "-m", "init wiki"]);
  }
}

function headCommit(wikiRoot) {
  return git(wikiRoot, ["rev-parse", "HEAD"]);
}

function changedRelPaths(wikiRoot, fromCommit) {
  const diff = git(wikiRoot, ["diff", "--name-only", fromCommit]);
  const untracked = git(wikiRoot, ["ls-files", "--others", "--exclude-standard"]);
  const names = new Set(
    [...diff.split("\n"), ...untracked.split("\n")].map((line) => line.trim()).filter(Boolean),
  );
  return [...names].sort();
}

function commitAll(wikiRoot, message) {
  git(wikiRoot, ["add", "-A"]);
  git(wikiRoot, ["commit", "-m", message]);
  return headCommit(wikiRoot);
}

function resetHard(wikiRoot, commit) {
  git(wikiRoot, ["reset", "--hard", commit]);
  git(wikiRoot, ["clean", "-fd"]);
}

function ingestMessage(action, sourcePath, sourceSha256) {
  return `ingest(${action}): ${sourcePath}@${sourceSha256.slice(0, 12)}`;
}

module.exports = {
  git,
  gitShow,
  ensureWikiRepo,
  headCommit,
  changedRelPaths,
  commitAll,
  resetHard,
  ingestMessage,
};
