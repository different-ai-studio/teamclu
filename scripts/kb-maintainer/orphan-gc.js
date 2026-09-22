"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter, serializeFrontmatter } = require("./frontmatter");
const { listPageFiles, rebuildIndex } = require("./validator");

function gcOrphanPages({ wikiRoot, state }) {
  const sources = state?.sources && typeof state.sources === "object" ? state.sources : {};
  const removed = [];
  const rewritten = [];

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

  return { removed, rewritten };
}

module.exports = { gcOrphanPages };
