"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter } = require("./frontmatter");
const { listPageFiles } = require("./validator");

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const INDEX_ITEM_RE = /^- \[\[pages\/([^\]|]+)(?:\|([^\]]+))?\]\] — (.+)$/;

function collectWikiLinks(text) {
  const links = [];
  text.replace(WIKI_LINK_RE, (_, target) => {
    links.push(target.trim());
    return _;
  });
  return links;
}

function parseIndexEntries(indexText) {
  const entries = [];
  for (const line of indexText.split("\n")) {
    const match = INDEX_ITEM_RE.exec(line.trim());
    if (match) entries.push({ slug: match[1], title: match[2] || match[1], summary: match[3] });
  }
  return entries;
}

function headings(body) {
  return [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
}

function daysSince(iso, now) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return 0;
  return (now - stamp) / 86400000;
}

function lintBatch(opts) {
  const { wikiRoot, state, config } = opts;
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const limits = config?.limits || {};
  const freshnessDays = limits.freshnessDays ?? 180;
  const maxChars = limits.maxIndexChars ?? 8000;
  const errors = [];
  const warnings = [];
  const sources = state?.sources || {};
  const pages = listPageFiles(wikiRoot);
  const parsedPages = [];

  for (const rel of pages) {
    const abs = path.join(wikiRoot, rel);
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
      continue;
    }
    parsedPages.push({ rel, ...parsed });
    if (Buffer.byteLength(fs.readFileSync(abs), "utf8") > maxChars) {
      errors.push(`${rel}: exceeds ${maxChars} chars`);
    }
    for (const source of parsed.frontmatter.sources || []) {
      const recorded = sources[source.path];
      if (!recorded || recorded.status !== "imported") {
        errors.push(`${rel}: source not in current set: ${source.path}`);
        continue;
      }
      if (source.sha256 && recorded.sourceSha256 && source.sha256 !== recorded.sourceSha256) {
        errors.push(`${rel}: source sha256 mismatch`);
      }
    }
    for (const target of collectWikiLinks(parsed.body)) {
      const relTarget = target.endsWith(".md") ? target : `${target}.md`;
      if (!fs.existsSync(path.join(wikiRoot, relTarget))) {
        errors.push(`${rel}: dead wiki link ${target}`);
      }
    }
    if (parsed.frontmatter.updated && daysSince(String(parsed.frontmatter.updated), now) > freshnessDays) {
      warnings.push(`${rel}: stale page`);
    }
  }

  const indexAbs = path.join(wikiRoot, "index.md");
  if (!fs.existsSync(indexAbs)) {
    errors.push("wiki/index.md is missing");
  } else {
    const indexText = fs.readFileSync(indexAbs, "utf8");
    if (Buffer.byteLength(indexText, "utf8") > maxChars) errors.push("index exceeds maxIndexChars");
    const entries = parseIndexEntries(indexText);
    const seen = new Map();
    for (const entry of entries) {
      if (seen.has(entry.slug)) errors.push(`index repeats ${entry.slug}`);
      seen.set(entry.slug, entry);
      if (!fs.existsSync(path.join(wikiRoot, "pages", `${entry.slug}.md`))) {
        errors.push(`index points at missing pages/${entry.slug}.md`);
      }
    }
    for (const rel of pages) {
      const slug = rel.slice("pages/".length, -3);
      if (!seen.has(slug)) errors.push(`index missing ${rel}`);
    }
  }

  const summaries = new Map();
  const headingOwners = new Map();
  for (const page of parsedPages) {
    const summary = page.frontmatter.summary;
    if (summary) {
      if (!summaries.has(summary)) summaries.set(summary, []);
      summaries.get(summary).push(page.rel);
    }
    for (const heading of headings(page.body)) {
      if (!headingOwners.has(heading)) headingOwners.set(heading, []);
      headingOwners.get(heading).push(page.rel);
    }
  }
  for (const [summary, rels] of summaries) {
    if (rels.length > 1) warnings.push(`duplicate summary "${summary}": ${rels.join(", ")}`);
  }
  for (const [heading, rels] of headingOwners) {
    const unique = [...new Set(rels)];
    if (unique.length > 1) warnings.push(`shared heading "${heading}": ${unique.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { lintBatch };
