"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseFrontmatter,
  serializeFrontmatter,
  redactCompiledText,
  normalizeCompiledPage,
} = require("./frontmatter");
const { dropDeadWikiLinks, listPageFiles, rebuildIndex, isAllowedWikiPath } = require("./validator");
const { git, changedRelPaths, headCommit } = require("./git-store");

function pageCites(wikiRoot, rel, sourcePath) {
  try {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(wikiRoot, rel), "utf8"));
    return (parsed.frontmatter.sources || []).some((source) => source && source.path === sourcePath);
  } catch {
    return false;
  }
}

function restorePath(wikiRoot, commit, rel) {
  const abs = path.join(wikiRoot, rel);
  if (!existedAt(wikiRoot, commit, rel)) {
    fs.rmSync(abs, { recursive: true, force: true });
    return;
  }
  git(wikiRoot, ["checkout", commit, "--", rel]);
}

function fileStat(abs) {
  try {
    return fs.lstatSync(abs);
  } catch {
    return null;
  }
}

function existedAt(wikiRoot, commit, rel) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${rel}`], {
      cwd: wikiRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a compile that wandered: drop files outside the wiki, drop links, and
 * if the model touched more pages than the cap, restore the ones that do not
 * cite this source. A delete passes Infinity so every retracted page can stay.
 */
function limitCompileDiff(wikiRoot, beforeCommit, sourcePath, maxPages) {
  for (const rel of changedRelPaths(wikiRoot, beforeCommit)) {
    const abs = path.join(wikiRoot, rel);
    const stat = fileStat(abs);
    if (stat && (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))) {
      fs.rmSync(abs, { force: true });
      restorePath(wikiRoot, beforeCommit, rel);
      continue;
    }
    if (!isAllowedWikiPath(rel)) restorePath(wikiRoot, beforeCommit, rel);
  }
  if (!Number.isFinite(maxPages)) return;
  const pages = changedRelPaths(wikiRoot, beforeCommit).filter((rel) => rel.startsWith("pages/"));
  if (pages.length <= maxPages) return;
  const ranked = [...pages].sort((a, b) => {
    const rank = (rel) => {
      const abs = path.join(wikiRoot, rel);
      if (!fs.existsSync(abs)) return 3;
      if (pageCites(wikiRoot, rel, sourcePath)) return 0;
      if (!existedAt(wikiRoot, beforeCommit, rel)) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const rel of ranked.slice(maxPages)) restorePath(wikiRoot, beforeCommit, rel);
}

/**
 * Last pass before the wiki-wide check. Dead links, copied secrets, over-long
 * pages, and stale source hashes are compiler bookkeeping, not something a
 * person can edit in the maintenance screen.
 */
function repairWiki(wikiRoot, opts = {}) {
  const maxBytes = opts.maxBytes || 8000;
  const sources = opts.state?.sources || {};
  const before = headCommit(wikiRoot);
  dropDeadWikiLinks(wikiRoot);
  for (const rel of listPageFiles(wikiRoot)) {
    const abs = path.join(wikiRoot, rel);
    const original = fs.readFileSync(abs, "utf8");
    let parsed;
    try {
      parsed = parseFrontmatter(original);
    } catch {
      fs.writeFileSync(abs, normalizeCompiledPage(original, { maxBytes }));
      continue;
    }
    const fm = parsed.frontmatter;
    const summary = redactCompiledText(fm.summary);
    const body = redactCompiledText(parsed.body || "");
    let shaChanged = false;
    for (const source of fm.sources || []) {
      const recorded = sources[source.path];
      if (
        recorded?.status === "imported" &&
        recorded.sourceSha256 &&
        source.sha256 !== recorded.sourceSha256
      ) {
        source.sha256 = recorded.sourceSha256;
        shaChanged = true;
      }
    }
    const clean = summary === fm.summary && body === (parsed.body || "") && !shaChanged;
    if (clean && Buffer.byteLength(original) <= maxBytes) continue;
    if (clean) {
      fs.writeFileSync(
        abs,
        normalizeCompiledPage(original, { maxBytes, pageType: fm.type }),
      );
      continue;
    }
    fm.summary = summary;
    const nextBody = body.endsWith("\n") ? body : `${body}\n`;
    let next = serializeFrontmatter(fm, nextBody);
    if (Buffer.byteLength(next) > maxBytes) {
      next = normalizeCompiledPage(next, { maxBytes, pageType: fm.type });
    }
    fs.writeFileSync(abs, next);
  }
  rebuildIndex(wikiRoot);
  return { changed: changedRelPaths(wikiRoot, before).length > 0 };
}

module.exports = { limitCompileDiff, repairWiki };
