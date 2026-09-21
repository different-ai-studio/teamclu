"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseFrontmatter } = require("./frontmatter");

const DEFAULT_SET = path.join(__dirname, "fixtures", "eval-20.json");

function loadEvalSet(filePath = DEFAULT_SET) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw.questions) || raw.questions.length !== 20) {
    throw new Error("eval set must contain exactly 20 questions");
  }
  return raw.questions;
}

function scoreEval({ wikiRoot, questions }) {
  const hits = [];
  const misses = [];
  const criticalMisses = [];
  for (const item of questions) {
    const abs = path.join(wikiRoot, item.expectedPage);
    let ok = false;
    if (fs.existsSync(abs)) {
      try {
        const parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
        const locators = (parsed.frontmatter.sources || []).flatMap((source) => source.locators || []);
        ok =
          locators.includes(item.expectedLocator) &&
          parsed.body.includes(item.expectedSnippet);
      } catch {
        ok = false;
      }
    }
    if (ok) hits.push(item.id);
    else {
      misses.push(item.id);
      if (item.critical) criticalMisses.push(item.id);
    }
  }
  return {
    total: questions.length,
    hits: hits.length,
    hitRate: hits.length / questions.length,
    misses,
    criticalMisses,
  };
}

function meetsPilotThreshold(report) {
  return report.hitRate >= 0.8 && report.criticalMisses.length === 0;
}

module.exports = { loadEvalSet, scoreEval, meetsPilotThreshold, DEFAULT_SET };
