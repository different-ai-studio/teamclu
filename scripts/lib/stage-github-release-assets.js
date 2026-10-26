"use strict";

const fs = require("node:fs");
const path = require("node:path");

function safeReleaseName(name) {
  return name.replaceAll(" ", "_");
}

function collectAssetFiles(bundleDir) {
  const groups = [
    [path.join(bundleDir, "dmg"), (name) => name.endsWith(".dmg")],
    [
      path.join(bundleDir, "macos"),
      (name) => name.endsWith(".app.tar.gz") || name.endsWith(".app.tar.gz.sig"),
    ],
    [
      path.join(bundleDir, "nsis"),
      (name) => name.endsWith("-setup.exe") || name.endsWith("-setup.exe.sig"),
    ],
  ];
  const files = [];
  for (const [dir, pred] of groups) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!pred(name)) continue;
      files.push(path.join(dir, name));
    }
  }
  return files;
}

function stageGithubReleaseAssets(bundleDir, outDir) {
  const files = collectAssetFiles(bundleDir);
  if (files.length === 0) {
    throw new Error(`No GitHub Release assets under ${bundleDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const staged = [];
  for (const file of files) {
    const destName = safeReleaseName(path.basename(file));
    fs.copyFileSync(file, path.join(outDir, destName));
    staged.push(destName);
  }
  staged.sort();
  return staged;
}

function stageFirstBundle(outDir, candidates) {
  const tried = [];
  for (const dir of candidates) {
    tried.push(dir);
    if (!fs.existsSync(dir)) continue;
    if (collectAssetFiles(dir).length === 0) continue;
    return { bundleDir: dir, staged: stageGithubReleaseAssets(dir, outDir) };
  }
  throw new Error(`No bundle directory with release assets. Looked in: ${tried.join(", ")}`);
}

function main(argv) {
  const [outDir, ...candidates] = argv;
  if (!outDir || candidates.length === 0) {
    console.error("usage: stage-github-release-assets.js <outDir> <bundleDir>...");
    process.exit(2);
  }
  try {
    const { bundleDir, staged } = stageFirstBundle(outDir, candidates);
    console.log(`Staged ${staged.length} asset(s) from ${bundleDir}`);
    for (const name of staged) console.log(name);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  collectAssetFiles,
  safeReleaseName,
  stageFirstBundle,
  stageGithubReleaseAssets,
};

if (require.main === module) {
  main(process.argv.slice(2));
}
