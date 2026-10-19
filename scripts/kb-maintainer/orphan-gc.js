"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter, serializeFrontmatter } = require("./frontmatter");
const { listPageFiles, rebuildIndex } = require("./validator");
const { isRestrictedPath } = require("./acl-preflight");

function gcOrphanPages({ wikiRoot, state, restrictedPrefixes = [] }) {
  const sources = state?.sources && typeof state.sources === "object" ? state.sources : {};
  const removed = [];
  const rewritten = [];
  const recompile = new Set();

  for (const rel of listPageFiles(wikiRoot)) {
    const abs = path.join(wikiRoot, rel);
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    const cited = Array.isArray(parsed.frontmatter?.sources)
      ? parsed.frontmatter.sources
      : [];
    const kept = cited.filter(
      (source) => sources[source.path]?.status === "imported",
    );
    if (kept.length === cited.length) continue;

    // Detaching would leave a restricted source's facts in the body.
    const citesRestricted = cited.some(
      (source) => source?.path && isRestrictedPath(source.path, restrictedPrefixes),
    );
    if (citesRestricted) {
      for (const source of kept) {
        if (!isRestrictedPath(source.path, restrictedPrefixes)) recompile.add(source.path);
      }
      fs.rmSync(abs);
      removed.push(rel);
      continue;
    }

    if (kept.length === 0) {
      fs.rmSync(abs);
      removed.push(rel);
      continue;
    }

    fs.writeFileSync(
      abs,
      serializeFrontmatter(
        {
          ...parsed.frontmatter,
          sources: kept,
          managed_by: "llm-wiki",
          schema_version: 1,
        },
        parsed.body,
      ),
    );
    rewritten.push(rel);
  }

  if (removed.length > 0 || rewritten.length > 0) {
    rebuildIndex(wikiRoot);
  }

  return { removed, rewritten, recompile: [...recompile].sort() };
}

module.exports = { gcOrphanPages };
