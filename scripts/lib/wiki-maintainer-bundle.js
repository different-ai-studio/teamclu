"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const desktopDir = path.join(repoRoot, "apps/desktop");
const maintainerRoot = path.join(repoRoot, "scripts", "kb-maintainer");
const entry = path.join(maintainerRoot, "desktop-runner.js");

/**
 * JSON Merge Patch (RFC 7396), the same algorithm Tauri uses to overlay
 * `tauri.<platform>.conf.json` onto `tauri.conf.json`. Arrays replace the
 * target. Objects merge key by key. A macOS `resources` array therefore
 * deletes the base `kb-maintainer` mapping.
 */
function jsonMergePatch(target, patch) {
  if (isPlainObject(patch)) {
    const out = isPlainObject(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete out[key];
      else out[key] = jsonMergePatch(out[key], value);
    }
    return out;
  }
  return cloneJson(patch);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneJson(child);
    return out;
  }
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mergedBundleConfig(platformFile) {
  const base = readJson(path.join(desktopDir, "tauri.conf.json"));
  if (!platformFile) return base;
  const overlayPath = path.join(desktopDir, platformFile);
  if (!fs.existsSync(overlayPath)) return base;
  return jsonMergePatch(base, readJson(overlayPath));
}

const REQUIRE_RE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
const ASSET_RE = /path\.join\(\s*__dirname((?:\s*,\s*["'][^"']+["'])+)\s*\)/g;

function localRequires(source) {
  return [...source.matchAll(REQUIRE_RE)].map((match) => match[1]);
}

function localAssets(source) {
  const assets = [];
  for (const match of source.matchAll(ASSET_RE)) {
    const parts = [...match[1].matchAll(/["']([^"']+)["']/g)].map((part) => part[1]);
    if (parts.length > 0) assets.push(parts.join("/"));
  }
  return assets;
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Wiki maintainer require ${spec} from ${path.basename(fromFile)} did not resolve`);
}

/**
 * Files `desktop-runner.js` loads at runtime: the static require closure,
 * plus `path.join(__dirname, ...)` assets such as `templates/_schema.md`.
 * Test files stay out. The macOS bundle check requires every one of these,
 * not only the entry script.
 */
function wikiRuntimeFiles() {
  const files = new Set();
  const pending = [entry];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!abs.startsWith(`${maintainerRoot}${path.sep}`)) {
      throw new Error(`Wiki maintainer dependency escaped the script directory: ${abs}`);
    }
    const relative = path.relative(maintainerRoot, abs).split(path.sep).join("/");
    files.add(relative);
    const source = fs.readFileSync(abs, "utf8");
    for (const spec of localRequires(source)) {
      pending.push(resolveLocal(abs, spec));
    }
    for (const asset of localAssets(source)) {
      const assetAbs = path.resolve(path.dirname(abs), asset);
      if (!assetAbs.startsWith(`${maintainerRoot}${path.sep}`)) {
        throw new Error(`Wiki maintainer asset escaped the script directory: ${assetAbs}`);
      }
      if (!fs.existsSync(assetAbs) || !fs.statSync(assetAbs).isFile()) {
        throw new Error(`Wiki maintainer asset is missing: ${asset}`);
      }
      files.add(path.relative(maintainerRoot, assetAbs).split(path.sep).join("/"));
    }
  }
  return [...files].sort();
}

function bundleRelativeFiles(resources) {
  if (Array.isArray(resources) || !isPlainObject(resources)) {
    throw new Error(
      "macOS bundle.resources must be a map so platform config merges with tauri.conf.json",
    );
  }
  const expected = [];
  for (const [src, dest] of Object.entries(resources)) {
    const abs = path.resolve(desktopDir, src);
    if (!fs.existsSync(abs)) {
      throw new Error(`Bundle resource does not exist: ${src}`);
    }
    const destRel = String(dest).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!destRel || destRel.split("/").includes("..")) {
      throw new Error(`Bundle resource destination is unsafe: ${dest}`);
    }
    if (fs.statSync(abs).isDirectory()) {
      const root =
        path.resolve(abs) === path.resolve(maintainerRoot) ? wikiRuntimeFiles() : walkFiles(abs);
      for (const file of root) expected.push(`${destRel}/${file}`);
    } else {
      expected.push(destRel);
    }
  }
  return [...new Set(expected)].sort();
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  }
  return out.sort();
}

function macosResourceFiles() {
  const merged = mergedBundleConfig("tauri.macos.conf.json");
  return bundleRelativeFiles(merged.bundle && merged.bundle.resources);
}

function missingBundledFiles(appPath, relativeFiles) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  return relativeFiles.filter((relative) => {
    const abs = path.join(resourcesDir, ...relative.split("/"));
    return !fs.existsSync(abs) || !fs.statSync(abs).isFile();
  });
}

function assertAppHasWikiResources(appPath, relativeFiles = macosResourceFiles()) {
  const missing = missingBundledFiles(appPath, relativeFiles);
  if (missing.length === 0) return;
  throw new Error(
    `Wiki maintenance resources are missing from this build. ${appPath} is missing:\n${missing.join("\n")}`,
  );
}

function bundleSearchDirs({ repoRoot: root, target, debug, cargoTargetDir }) {
  const profile = debug ? "debug" : "release";
  const rel = target
    ? path.join(target, profile, "bundle", "macos")
    : path.join(profile, "bundle", "macos");
  const bases = cargoTargetDir
    ? [cargoTargetDir]
    : [path.join(root, "target"), path.join(root, "apps", "desktop", "target")];
  return bases.map((base) => path.join(base, rel));
}

function findMacosApps(options) {
  const apps = [];
  for (const dir of bundleSearchDirs(options)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".app")) apps.push(path.join(dir, name));
    }
  }
  return apps;
}

function assertMacosReleaseBundles(options) {
  const apps = options.apps && options.apps.length > 0 ? options.apps : findMacosApps(options);
  if (apps.length === 0) {
    const looked = bundleSearchDirs(options).join("\n");
    throw new Error(
      `Wiki maintenance resources are missing from this build. No macOS .app was found under:\n${looked}`,
    );
  }
  const relativeFiles = macosResourceFiles();
  for (const app of apps) assertAppHasWikiResources(app, relativeFiles);
  return apps;
}

module.exports = {
  jsonMergePatch,
  mergedBundleConfig,
  wikiRuntimeFiles,
  macosResourceFiles,
  missingBundledFiles,
  assertAppHasWikiResources,
  bundleSearchDirs,
  findMacosApps,
  assertMacosReleaseBundles,
  repoRoot,
  desktopDir,
};
