"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter, serializeFrontmatter } = require("./frontmatter");

const PAGE_TYPES = new Set(["policy", "process", "role", "term", "faq", "training", "source-summary"]);
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const INDEX_ITEM_RE = /^- \[\[pages\/([^\]|]+)(?:\|([^\]]+))?\]\] — (.+)$/;
const ID_CARD_RE = /\d{17}[\dXx]/;
const MOBILE_RE = /(?<![\d])1[3-9]\d{9}(?![\d])/;
const BANK_RE = /(?<![\d])\d{16,19}(?![\d])/;
const LEAK_RE = /chunk-id|source-locator: chunk=|<\/?tool|\/Users\/|\/home\/|C:\\/i;
const SECTION_BY_TYPE = {
  policy: "制度",
  process: "流程",
  role: "岗位",
  term: "术语",
  faq: "FAQ",
  training: "培训",
  "source-summary": "摘要",
};

function posixRel(filePath) {
  return filePath.split(path.sep).join("/");
}

function isAllowedWikiPath(rel) {
  if (rel.includes("\\") || rel.includes("\0") || rel.split("/").includes("..")) return false;
  if (rel === "index.md") return true;
  return rel.startsWith("pages/") && rel.endsWith(".md") && !rel.slice("pages/".length).includes("/");
}

function collectWikiLinks(text) {
  const links = [];
  text.replace(WIKI_LINK_RE, (_, target) => {
    links.push(target.trim());
    return _;
  });
  return links;
}

function wikiLinkCandidates(target) {
  const trimmed = String(target || "").trim();
  if (!trimmed) return [];
  const withoutMd = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  const rel = `${withoutMd}.md`;
  const candidates = [rel];
  if (!withoutMd.startsWith("pages/") && !withoutMd.includes("/")) {
    candidates.push(`pages/${rel}`);
  }
  return candidates;
}

function resolveWikiLink(wikiRoot, target) {
  return wikiLinkCandidates(target).some((rel) => fs.existsSync(path.join(wikiRoot, rel)));
}

function canonicalWikiTarget(wikiRoot, target) {
  const trimmed = String(target || "").trim();
  if (!trimmed) return null;
  const withoutMd = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  if (withoutMd.startsWith("pages/")) {
    return fs.existsSync(path.join(wikiRoot, `${withoutMd}.md`)) ? withoutMd : null;
  }
  if (!withoutMd.includes("/") && fs.existsSync(path.join(wikiRoot, "pages", `${withoutMd}.md`))) {
    return `pages/${withoutMd}`;
  }
  return null;
}

function rewriteWikiLinksInText(text, wikiRoot) {
  return text.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (full, target, hash, alias) => {
    const canonical = canonicalWikiTarget(wikiRoot, target);
    if (!canonical || canonical === target.trim()) return full;
    return `[[${canonical}${hash || ""}${alias || ""}]]`;
  });
}

function normalizeWikiLinks(wikiRoot) {
  let rewritten = 0;
  const files = listPageFiles(wikiRoot);
  const indexAbs = path.join(wikiRoot, "index.md");
  if (fs.existsSync(indexAbs)) files.push("index.md");
  for (const rel of files) {
    const abs = path.join(wikiRoot, rel);
    const before = fs.readFileSync(abs, "utf8");
    const after = rewriteWikiLinksInText(before, wikiRoot);
    if (after === before) continue;
    fs.writeFileSync(abs, after);
    rewritten += 1;
  }
  return { rewritten };
}

function locatorPresent(rawMarkdown, locator) {
  return rawMarkdown.includes(`<!-- source-locator: ${locator} -->`);
}

function listPageFiles(wikiRoot) {
  const dir = path.join(wikiRoot, "pages");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `pages/${name}`)
    .sort();
}

function parseIndexEntries(indexText) {
  const entries = [];
  for (const line of indexText.split("\n")) {
    const match = INDEX_ITEM_RE.exec(line.trim());
    if (match) {
      entries.push({ slug: match[1], title: match[2] || match[1], summary: match[3] });
    }
  }
  return entries;
}

function scalarSummary(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

function pageDisplay(parsed, slug) {
  const heading = /^(#{1,6})\s+(.+)$/m.exec(parsed.body);
  return heading ? heading[2].trim() : slug;
}

function indexAlias(display) {
  const cleaned = String(display || "")
    .replace(/[\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "page";
}

function indexSummaryFor(parsed, slug) {
  return scalarSummary(parsed.frontmatter.summary) || pageDisplay(parsed, slug);
}

function validateSourceDiff(opts) {
  const errors = [];
  const { wikiRoot, rawRoot, changedRelPaths, currentSource, config } = opts;
  const limits = config.limits || {};
  const maxPages = limits.maxPagesChangedPerSource ?? 15;
  const maxChars = limits.maxIndexChars ?? 8000;

  for (const rel of changedRelPaths) {
    if (!isAllowedWikiPath(rel)) {
      errors.push(`diff escapes wiki/pages or index: ${rel}`);
    }
    const abs = path.join(wikiRoot, rel);
    if (fs.existsSync(abs)) {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || stat.nlink > 1) {
        errors.push(`link not allowed: ${rel}`);
      }
    }
  }

  const changedPages = changedRelPaths.filter((rel) => rel.startsWith("pages/"));
  if (changedPages.length > maxPages) {
    errors.push(`changed ${changedPages.length} pages, max is ${maxPages}`);
  }

  const rawAbs = path.join(rawRoot, currentSource.rawRelPath);
  const rawMarkdown = fs.existsSync(rawAbs) ? fs.readFileSync(rawAbs, "utf8") : "";
  const rawBody = rawMarkdown.includes("\n---\n")
    ? rawMarkdown.slice(rawMarkdown.indexOf("\n---\n") + 5)
    : rawMarkdown;

  for (const rel of changedPages) {
    const abs = path.join(wikiRoot, rel);
    if (!fs.existsSync(abs)) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
      continue;
    }
    const fm = parsed.frontmatter;
    if (fm.managed_by !== "llm-wiki") errors.push(`${rel}: managed_by must be llm-wiki`);
    if (fm.schema_version !== 1) errors.push(`${rel}: unsupported schema_version`);
    if (!PAGE_TYPES.has(fm.type)) errors.push(`${rel}: illegal type ${fm.type}`);
    if (!Array.isArray(fm.sources) || fm.sources.length === 0) errors.push(`${rel}: sources required`);
    const citesCurrent = (fm.sources || []).some((source) => source.path === currentSource.path);
    const text = `${parsed.body}\n${fm.summary || ""}`;
    if (ID_CARD_RE.test(text) || MOBILE_RE.test(text) || /保单号/.test(text) && /\d{6,}/.test(text)) {
      errors.push(`${rel}: PII or sensitive identifier`);
    }
    if (BANK_RE.test(text) && text.length > 40 && /\d{16,}/.test(text.replace(/\s/g, ""))) {
      errors.push(`${rel}: PII bank number`);
    }
    if (LEAK_RE.test(parsed.body)) errors.push(`${rel}: internal leak`);
    if (Buffer.byteLength(fs.readFileSync(abs), "utf8") > maxChars) {
      errors.push(`${rel}: exceeds ${maxChars} chars`);
    }
    if (fm.type === "source-summary" && parsed.body.trim().length > (limits.maxSourceSummaryChars ?? 4000)) {
      errors.push(`${rel}: source-summary too large`);
    }
    if (
      citesCurrent &&
      rawBody.length > 2000 &&
      parsed.body.trim().length > 0.9 * rawBody.trim().length
    ) {
      errors.push(`${rel}: copy ratio too high`);
    }
    for (const source of fm.sources || []) {
      if (source.path === currentSource.path && source.sha256 !== currentSource.sourceSha256) {
        errors.push(`${rel}: source sha256 mismatch`);
      }
      for (const locator of source.locators || []) {
        if (source.path === currentSource.path && !locatorPresent(rawMarkdown, locator)) {
          errors.push(`${rel}: locator not in raw: ${locator}`);
        }
      }
    }
    for (const target of collectWikiLinks(parsed.body)) {
      if (!resolveWikiLink(wikiRoot, target) && !changedRelPaths.includes(target.endsWith(".md") ? target : `${target}.md`)) {
        errors.push(`${rel}: dead wiki link ${target}`);
      }
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
    }
    for (const rel of listPageFiles(wikiRoot)) {
      const slug = rel.slice("pages/".length, -3);
      const entry = seen.get(slug);
      if (!entry) {
        errors.push(`index missing ${rel}`);
        continue;
      }
      const parsed = parseFrontmatter(fs.readFileSync(path.join(wikiRoot, rel), "utf8"));
      const expected = indexSummaryFor(parsed, slug);
      if (entry.summary !== expected) {
        errors.push(
          `index summary mismatch for ${rel}: index=${JSON.stringify(entry.summary)} page=${JSON.stringify(expected)}`,
        );
      }
    }
    for (const slug of seen.keys()) {
      if (!fs.existsSync(path.join(wikiRoot, "pages", `${slug}.md`))) {
        errors.push(`index points at missing pages/${slug}.md`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function rebuildIndex(wikiRoot) {
  const groups = new Map();
  for (const rel of listPageFiles(wikiRoot)) {
    const abs = path.join(wikiRoot, rel);
    let parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    const slug = rel.slice("pages/".length, -3);
    const summary = indexSummaryFor(parsed, slug);
    if (parsed.frontmatter.summary !== summary) {
      parsed.frontmatter.summary = summary;
      fs.writeFileSync(abs, serializeFrontmatter(parsed.frontmatter, parsed.body));
      parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    }
    const type = parsed.frontmatter.type;
    const display = indexAlias(pageDisplay(parsed, slug));
    const section = SECTION_BY_TYPE[type] || type;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push({
      slug,
      display,
      summary: indexSummaryFor(parsed, slug),
    });
  }
  const lines = ["# LLM Wiki", ""];
  for (const [section, pages] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"))) {
    lines.push(`## ${section}`);
    for (const page of pages.sort((a, b) => a.slug.localeCompare(b.slug, "zh"))) {
      lines.push(`- [[pages/${page.slug}|${page.display}]] — ${page.summary}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(wikiRoot, "index.md"), `${lines.join("\n").trim()}\n`);
}

module.exports = {
  PAGE_TYPES,
  SECTION_BY_TYPE,
  validateSourceDiff,
  rebuildIndex,
  normalizeWikiLinks,
  listPageFiles,
  isAllowedWikiPath,
  posixRel,
};
