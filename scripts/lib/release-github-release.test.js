"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

test("release-oss publishes a TeamClu GitHub Release from the same desktop artifacts", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/release-oss.yml"), "utf8");
  assert.match(workflow, /publish-github-release:/);
  assert.match(workflow, /inputs\.brand == 'teamclu'/);
  assert.match(workflow, /node scripts\/lib\/stage-github-release-assets\.js/);
  assert.match(workflow, /node scripts\/publish-teamclu-github-release\.js/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /publish-github-release:[\s\S]*NIGHTLY_DISPATCH_PAT/);
});

test("release.yml skips the nightly bump commit so it does not build that tag again", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /chore\(release\): nightly beta /);
  assert.match(workflow, /needs\.verify-version-bump\.outputs\.publish == 'true'/);
});

test("nightly documents that the teamclu dispatch also updates the GitHub Release", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github/workflows/nightly-release-oss.yml"),
    "utf8",
  );
  assert.match(workflow, /GitHub Release/);
  assert.match(workflow, /release-oss\.yml/);
});
