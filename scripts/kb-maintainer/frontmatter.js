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
  let currentSource = null;
  let listField = null;

  for (const line of header.split("\n")) {
    if (line.trim() === "") continue;

    const item = /^  - ([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (item && sources) {
      currentSource = { [item[1]]: parseScalar(item[2]) };
      sources.push(currentSource);
      listField = null;
      continue;
    }

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listField) {
      listField.target[listField.key].push(parseScalar(listItem[1]));
      continue;
    }

    if (line === "sources:") {
      sources = [];
      frontmatter.sources = sources;
      currentSource = null;
      listField = null;
      continue;
    }

    const nested = /^    ([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (nested && currentSource) {
      const key = nested[1];
      const raw = nested[2];
      if (raw === "") {
        currentSource[key] = [];
        listField = { target: currentSource, key };
      } else {
        currentSource[key] = parseScalar(raw);
        listField = null;
      }
      continue;
    }

    const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!field) {
      throw new Error(`unreadable frontmatter line: ${line}`);
    }
    frontmatter[field[1]] = parseScalar(field[2]);
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
  for (const source of frontmatter.sources) {
    lines.push(`  - path: ${source.path}`);
    lines.push(`    sha256: ${source.sha256}`);
    lines.push(`    locators: ${JSON.stringify(source.locators)}`);
  }
  lines.push(`updated: ${frontmatter.updated}`);
  lines.push("---");
  lines.push("");
  const suffix = body.endsWith("\n") ? body : `${body}\n`;
  return `${lines.join("\n")}${suffix}`;
}

module.exports = { parseFrontmatter, serializeFrontmatter, quoteYamlScalar };
