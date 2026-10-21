#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  applyNameToExtensionManifest,
  resolveExtensionIconPlan,
  resolveLogoPlan,
} = require('./lib/branding');
const {
  resolveExtensionPack,
  domainsToChromeMatchPatterns,
} = require('./lib/extension-config');

const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'apps/extension', 'manifest.json');

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function deepMerge(base, overlay) {
  if (!overlay) return base;
  const result = { ...base };
  for (const key of Object.keys(overlay)) {
    const baseVal = result[key];
    const overVal = overlay[key];
    if (
      baseVal && overVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}

// Read and merge build configs (same precedence as update-tauri-config.js:
// base -> build.config.<BUILD_ENV>.json -> build.config.local.json).
const buildEnv = process.env.BUILD_ENV;
const baseConfig = readJSON(path.join(rootDir, 'build.config.json')) || {};
const envConfig = buildEnv ? readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) : null;
const localConfig = readJSON(path.join(rootDir, 'build.config.local.json'));

let buildConfig = baseConfig;
if (envConfig) buildConfig = deepMerge(buildConfig, envConfig);
if (localConfig) buildConfig = deepMerge(buildConfig, localConfig);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let updated = false;

if (applyNameToExtensionManifest(manifest, buildConfig)) {
  console.log(`✓ Updated extension identity: ${manifest.name} — ${manifest.description}`);
  updated = true;
}

// Brand-scoped host access from `extensions.domains` / `extension.hosts`
// (e.g. *.shopee.io). Non-empty → the brand gets install-time host access and a
// static content script on exactly those hosts (its side panel is gated to
// them anyway), and no optional all-sites access.
//
// The default (unbranded TeamClu) manifest declares NO install-time host access
// and NO static content script: page access comes from activeTab, from
// `optional_host_permissions` the user grants from the side panel, and from a
// content script the background registers only for link-hover domains the user
// allow-listed (see apps/extension/src/lib/dynamic-content-script.ts). That is
// what the Chrome Web Store review asked for — keep it that way.
const extensionPack = resolveExtensionPack(buildConfig);
const brandHosts = domainsToChromeMatchPatterns(extensionPack.domains);
if (brandHosts.length > 0) {
  manifest.host_permissions = [...brandHosts];
  manifest.content_scripts = [
    { matches: [...brandHosts], js: ['content-script.js'], run_at: 'document_idle' },
  ];
  delete manifest.optional_host_permissions;
  console.log(`✓ Scoped extension hosts to ${brandHosts.length} pattern(s)`);
  updated = true;
}

// Chrome Web Store requires x.y.z(.w) version numbers — mirror app version if set.
if (buildConfig.app && buildConfig.app.version && manifest.version !== buildConfig.app.version) {
  manifest.version = buildConfig.app.version;
  console.log(`✓ Updated extension version: ${manifest.version}`);
  updated = true;
}

if (updated) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const iconPlan = resolveExtensionIconPlan(rootDir);
if (iconPlan) {
  fs.mkdirSync(iconPlan.outDir, { recursive: true });
  for (const { source, dest } of iconPlan.files) {
    fs.copyFileSync(source, dest);
    console.log(`✓ Wrote branded icon: ${dest}`);
  }
} else {
  console.log('ℹ️ No branding/extension/icons found — keeping default icons');
}

// The side panel renders /logo.png and /logo-64.png (welcome, login, about,
// file tree). Those live in packages/app/public/ and were only ever rebranded
// by scripts/update-tauri-config.js — the desktop path. Nothing applied them
// for the extension, so a package correctly named "Copilot 361" opened onto a
// side panel still showing the TeamClu mark.
//
// Unlike the desktop flow this copies app.logo straight through instead of
// resizing it via `tauri icon`: the extension pipeline deliberately does no
// image conversion in CI, and both slots are rendered at CSS sizes anyway.
const logoPlan = resolveLogoPlan(buildConfig, rootDir);
if (logoPlan) {
  if (!fs.existsSync(logoPlan.source)) {
    console.error(`✗ app.logo source not found: ${logoPlan.source}`);
    process.exit(1);
  }
  for (const target of logoPlan.publicLogoTargets) {
    fs.copyFileSync(logoPlan.source, target);
    console.log(`✓ Wrote in-app logo: ${path.relative(rootDir, target)}`);
  }
} else {
  console.log('ℹ️ No app.logo configured — keeping default in-app logo');
}
