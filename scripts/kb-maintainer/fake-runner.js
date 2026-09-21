"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter, serializeFrontmatter } = require("./frontmatter");
const { rebuildIndex } = require("./validator");
const { rawRelativePath } = require("./extract-text");

function firstHeading(markdown) {
  const body = markdown.includes("\n---\n")
    ? markdown.slice(markdown.indexOf("\n---\n") + 5)
    : markdown;
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
  return match ? match[1].trim() : null;
}

function bodyWithoutLocators(markdown) {
  const parsed = markdown.startsWith("---\n") ? parseFrontmatter(markdown).body : markdown;
  return parsed.replace(/<!-- source-locator: .*? -->\n?/g, "").trim();
}

function firstSummary(markdown, fallback) {
  const body = bodyWithoutLocators(markdown);
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  if (!line) return `${fallback}。`;
  return line.length > 40 ? `${line.slice(0, 39)}。` : /[。.!？?]$/.test(line) ? line : `${line}`;
}

function pageFileName(title) {
  return `${title.replace(/[\\/]/g, "-").replace(/\s+/g, "-")}.md`;
}

function rawRootOf(ctx) {
  return ctx.rawRoot || path.join(ctx.workRoot, "raw");
}

function bodyFromSources(ctx, sources) {
  return sources
    .map((source) => {
      const abs = path.join(rawRootOf(ctx), rawRelativePath(source.path));
      if (!fs.existsSync(abs)) {
        throw new Error(`raw cache missing for ${source.path}`);
      }
      return bodyWithoutLocators(fs.readFileSync(abs, "utf8"));
    })
    .join("\n\n");
}

function compile(ctx) {
  const wikiRoot = path.join(ctx.workRoot, "wiki");
  fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
  if (ctx.action === "delete") {
    return retractPages(ctx, wikiRoot);
  }
  const title = firstHeading(ctx.rawMarkdown) || "untitled";
  const rel = `pages/${pageFileName(title)}`;
  const today = ctx.updated || "2026-09-20";
  const nextSource = {
    path: ctx.sourcePath,
    sha256: ctx.sourceSha256,
    locators: ctx.locators,
  };
  const abs = path.join(wikiRoot, rel);
  let sources = [nextSource];
  if (fs.existsSync(abs)) {
    const existing = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    sources = [...(existing.frontmatter.sources || []).filter((source) => source.path !== ctx.sourcePath), nextSource];
  }
  const page = serializeFrontmatter(
    {
      type: ctx.pageType || "policy",
      summary: firstSummary(ctx.rawMarkdown, title),
      managed_by: "llm-wiki",
      schema_version: 1,
      sources,
      updated: today,
    },
    bodyFromSources(ctx, sources),
  );
  fs.writeFileSync(abs, page);
  rebuildIndex(wikiRoot);
  return { affectedPages: [rel] };
}

function retractPages(ctx, wikiRoot) {
  const affected = [];
  for (const rel of ctx.affectedPages || []) {
    const abs = path.join(wikiRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    const remaining = (parsed.frontmatter.sources || []).filter((source) => source.path !== ctx.sourcePath);
    affected.push(rel);
    if (remaining.length === 0) {
      fs.rmSync(abs);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/m.exec(parsed.body);
    const title = heading ? heading[2].trim() : rel.slice("pages/".length, -3);
    const page = serializeFrontmatter(
      {
        type: parsed.frontmatter.type,
        summary: firstSummary(bodyFromSources(ctx, remaining), title),
        managed_by: "llm-wiki",
        schema_version: parsed.frontmatter.schema_version,
        sources: remaining,
        updated: ctx.updated || "2026-09-20",
      },
      bodyFromSources(ctx, remaining),
    );
    fs.writeFileSync(abs, page);
  }
  rebuildIndex(wikiRoot);
  return { affectedPages: affected };
}

module.exports = { compile, firstHeading, pageFileName };
