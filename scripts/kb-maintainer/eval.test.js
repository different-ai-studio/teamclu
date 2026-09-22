"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serializeFrontmatter } = require("./frontmatter");
const { loadEvalSet, scoreEval, meetsPilotThreshold } = require("./eval-set");

test("scoreEval requires 80% hits and zero critical misses", () => {
  const questions = loadEvalSet();
  assert.equal(questions.length, 20);
  assert.ok(questions.filter((item) => item.critical).length >= 5);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const byPage = new Map();
  for (const item of questions) {
    if (!byPage.has(item.expectedPage)) {
      byPage.set(item.expectedPage, { locators: new Set(), snippets: [], title: item.expectedPage });
    }
    const bucket = byPage.get(item.expectedPage);
    bucket.locators.add(item.expectedLocator);
    bucket.snippets.push(item.expectedSnippet);
  }

  for (const [rel, bucket] of byPage) {
    const title = rel.replace(/^pages\//, "").replace(/\.md$/, "");
    const body = [`# ${title}`, "", ...bucket.snippets].join("\n");
    fs.mkdirSync(path.dirname(path.join(wikiRoot, rel)), { recursive: true });
    fs.writeFileSync(
      path.join(wikiRoot, rel),
      serializeFrontmatter(
        {
          type: "policy",
          summary: `${title}。`,
          managed_by: "llm-wiki",
          schema_version: 1,
          sources: [
            {
              path: "documents/handbook/fixture.md",
              sha256: "dd".repeat(32),
              locators: [...bucket.locators],
            },
          ],
          updated: "2026-09-20",
        },
        `${body}\n`,
      ),
    );
  }

  const full = scoreEval({ wikiRoot, questions });
  assert.equal(full.hits, 20);
  assert.equal(full.hitRate, 1);
  assert.equal(meetsPilotThreshold(full), true);

  fs.rmSync(path.join(wikiRoot, questions.find((item) => item.critical).expectedPage));
  const missingCritical = scoreEval({ wikiRoot, questions });
  assert.equal(meetsPilotThreshold(missingCritical), false);
  assert.ok(missingCritical.criticalMisses.length >= 1);
});
