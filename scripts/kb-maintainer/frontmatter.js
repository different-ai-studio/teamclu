"use strict";

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[")) {
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch {
      return value;
    }
  }
  return value;
}

function quoteYamlScalar(value) {
  const text = String(value ?? "");
  if (
    text === "" ||
    text === "true" ||
    text === "false" ||
    /^-?\d+$/.test(text) ||
    /[:#\[\]{}&*!|>'"%@`]/.test(text) ||
    text.includes("\n") ||
    text.trim() !== text
  ) {
    return JSON.stringify(text);
  }
  return text;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    throw new Error("missing frontmatter");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("unterminated frontmatter");
  }
  const header = text.slice(4, end);
  const body = text.slice(end + 5);
  const frontmatter = {};
  let sources = null;
  let inSources = false;
  let currentSource = null;
  let sourceIndent = null;
  let listField = null;

  for (const line of header.split("\n")) {
    if (line.trim() === "") continue;

    if (inSources) {
      const dashed = /^(\s*)-\s+(.*)$/.exec(line);
      if (dashed) {
        const indent = dashed[1].length;
        const rest = dashed[2];
        const keyed = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(rest);
        if (keyed && (sourceIndent === null || indent <= sourceIndent)) {
          sourceIndent = indent;
          currentSource = { [keyed[1]]: parseScalar(keyed[2]) };
          sources.push(currentSource);
          listField = null;
          continue;
        }
        if (listField) {
          listField.target[listField.key].push(parseScalar(rest));
          continue;
        }
      }

      const nested = /^(\s+)([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (nested && currentSource && sourceIndent !== null && nested[1].length > sourceIndent) {
        const key = nested[2];
        const raw = nested[3];
        if (raw === "") {
          currentSource[key] = [];
          listField = { target: currentSource, key };
        } else {
          currentSource[key] = parseScalar(raw);
          listField = null;
        }
        continue;
      }
    }

    if (/^sources:\s*$/.test(line)) {
      sources = [];
      frontmatter.sources = sources;
      inSources = true;
      currentSource = null;
      sourceIndent = null;
      listField = null;
      continue;
    }

    const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!field) {
      throw new Error(`unreadable frontmatter line: ${line}`);
    }
    frontmatter[field[1]] = parseScalar(field[2]);
    inSources = false;
    currentSource = null;
    listField = null;
  }
  return { frontmatter, body };
}

function serializeFrontmatter(frontmatter, body) {
  const lines = [
    "---",
    `type: ${frontmatter.type}`,
    `summary: ${quoteYamlScalar(frontmatter.summary)}`,
    `managed_by: ${frontmatter.managed_by}`,
    `schema_version: ${frontmatter.schema_version}`,
    "sources:",
  ];
  for (const source of frontmatter.sources || []) {
    lines.push(`  - path: ${source.path}`);
    lines.push(`    sha256: ${source.sha256}`);
    lines.push(`    locators: ${JSON.stringify(source.locators || [])}`);
  }
  lines.push(`updated: ${frontmatter.updated}`);
  lines.push("---");
  lines.push("");
  const suffix = body.endsWith("\n") ? body : `${body}\n`;
  return `${lines.join("\n")}${suffix}`;
}

const PAGE_TYPES = new Set(["policy", "process", "role", "term", "faq", "training", "source-summary"]);

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function locatorList(value) {
  if (Array.isArray(value)) return value.map((item) => oneLine(item)).filter(Boolean);
  const text = oneLine(value);
  return text ? [text] : [];
}

function locatorsInRaw(rawMarkdown, locators) {
  return locatorList(locators).filter((locator) =>
    String(rawMarkdown || "").includes(`<!-- source-locator: ${locator} -->`),
  );
}

function clipUtf8(text, maxBytes) {
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

function fitPage(frontmatter, body, maxBytes) {
  const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
  const full = serializeFrontmatter(frontmatter, normalizedBody);
  if (Buffer.byteLength(full) <= maxBytes) return full;

  const paragraphs = normalizedBody.split(/\n{2,}/).filter((part) => part.trim());
  const kept = [];
  for (const paragraph of paragraphs) {
    const trialBody = `${[...kept, paragraph].join("\n\n")}\n`;
    if (Buffer.byteLength(serializeFrontmatter(frontmatter, trialBody)) > maxBytes) break;
    kept.push(paragraph);
  }
  let nextBody = kept.length > 0 ? `${kept.join("\n\n")}\n` : "\n";
  let page = serializeFrontmatter(frontmatter, nextBody);
  if (Buffer.byteLength(page) > maxBytes) {
    const room = Math.max(0, maxBytes - Buffer.byteLength(serializeFrontmatter(frontmatter, "\n")));
    nextBody = `${clipUtf8(normalizedBody.trim(), room).trim()}\n`;
    page = serializeFrontmatter(frontmatter, nextBody);
  }
  return page;
}

/**
 * Models emit ordinary YAML and sometimes omit required fields or write a page
 * longer than the reader can load. Repair that here so a finished compile is
 * not thrown away.
 */
function normalizeCompiledPage(text, defaults = {}) {
  const hint = PAGE_TYPES.has(defaults.pageType) ? defaults.pageType : "source-summary";
  let parsed;
  try {
    parsed = parseFrontmatter(text.startsWith("---\n") ? text : `---\ntype: ${hint}\n---\n\n${text}`);
  } catch {
    const body = String(text || "").replace(/^---[\s\S]*?\n---\n?/, "");
    parsed = { frontmatter: {}, body };
  }
  const fm = parsed.frontmatter;
  if (!PAGE_TYPES.has(fm.type)) fm.type = hint;
  if (typeof fm.summary !== "string" || !oneLine(fm.summary)) {
    const heading = /^(#{1,6})\s+(.+)$/m.exec(parsed.body || "");
    fm.summary = oneLine(heading ? heading[2] : "") || "摘要";
  } else {
    fm.summary = oneLine(fm.summary);
  }
  fm.managed_by = "llm-wiki";
  fm.schema_version = 1;
  if (!fm.updated) fm.updated = new Date().toISOString().slice(0, 10);

  const raw = defaults.rawMarkdown || "";
  const extracted = locatorsInRaw(raw, defaults.locators);
  if (!Array.isArray(fm.sources)) fm.sources = [];
  let cited = fm.sources.find((source) => source && source.path === defaults.sourcePath);
  if (!defaults.sourcePath) {
    cited = null;
  } else if (!cited) {
    fm.sources.unshift({
      path: defaults.sourcePath,
      sha256: defaults.sourceSha256,
      locators: extracted,
    });
  } else {
    cited.sha256 = defaults.sourceSha256 || cited.sha256;
    const kept = locatorsInRaw(raw, cited.locators);
    cited.locators = kept.length > 0 ? kept : extracted;
  }
  for (const source of fm.sources) {
    source.locators = locatorList(source.locators);
  }

  return fitPage(fm, parsed.body || "", defaults.maxBytes || 8000);
}

module.exports = {
  parseFrontmatter,
  serializeFrontmatter,
  quoteYamlScalar,
  normalizeCompiledPage,
};
