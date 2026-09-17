"use strict";

// Guardrail: GitHub parses workflow files before anything runs, and a syntax
// error there is SILENT locally but fatal in CI — GitHub rejects the whole
// file ("This run likely failed because of a workflow file issue"), so every
// job in it stops running and nothing visibly goes red.
//
// That happened in #1509: a step named `Gate: unified sidecar reqwest features
// (rustls only)` was added unquoted, and a plain YAML scalar cannot contain
// ": " — both ci.yml and release-oss.yml became unparseable, which disabled CI
// and made the release workflow undispatchable.
//
// This repo's script tests run on bare node with no YAML library, so this does
// not parse YAML. It checks the two cheap invariants that would have caught
// that breakage: no unquoted ": " inside a `name:` value, and the top-level
// `on:` / `jobs:` keys still present in every workflow.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const workflowsDir = path.join(repoRoot, ".github/workflows");

const files = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

test("the workflow directory was actually scanned", () => {
  assert.ok(files.length >= 10, `expected the repo's workflow files, found ${files.length}`);
});

test("no workflow has an unquoted ': ' inside a `name:` value", () => {
  // Quoted ("…" / '…'), block (| / >), flow ([ / {) values are exempt, and the
  // scan stops at '#' so a trailing comment cannot trip it.
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(workflowsDir, file), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const unquotedColonSpace =
        /^\s*-\s*name:\s+[^"'|>#[{][^#]*:\s/.test(line) || /^name:\s+[^"'|>#[{][^#]*:\s/.test(line);
      if (unquotedColonSpace) {
        offenders.push(`.github/workflows/${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test("every workflow still has its top-level on: and jobs: keys", () => {
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
    if (!/^on:/m.test(text)) missing.push(`.github/workflows/${file}: no top-level on:`);
    if (!/^jobs:/m.test(text)) missing.push(`.github/workflows/${file}: no top-level jobs:`);
  }
  assert.deepEqual(missing, []);
});
