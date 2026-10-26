"use strict";

// Shape of the latest.json that release.yml's tauri-action attaches to a
// GitHub Release. Official clients download it from
// releases/latest/download/latest.json and then fetch each platform via the
// GitHub asset API URL.

const REQUIRED_ASSET_CHECKS = [
  ["macos aarch64 updater", (name) => name.endsWith(".app.tar.gz") && name.includes("aarch64")],
  [
    "macos aarch64 updater signature",
    (name) => name.endsWith(".app.tar.gz.sig") && name.includes("aarch64"),
  ],
  ["macos aarch64 dmg", (name) => name.endsWith(".dmg") && name.includes("aarch64")],
  [
    "macos x64 updater",
    (name) =>
      name.endsWith(".app.tar.gz") &&
      !name.includes("aarch64") &&
      (name.includes("x86_64") || name.includes("x64")),
  ],
  [
    "macos x64 updater signature",
    (name) =>
      name.endsWith(".app.tar.gz.sig") &&
      !name.includes("aarch64") &&
      (name.includes("x86_64") || name.includes("x64")),
  ],
  [
    "macos x64 dmg",
    (name) =>
      name.endsWith(".dmg") &&
      !name.includes("aarch64") &&
      (name.includes("x86_64") || name.includes("x64")),
  ],
  ["windows setup exe", (name) => name.endsWith("-setup.exe")],
  ["windows setup signature", (name) => name.endsWith("-setup.exe.sig")],
];

const PLATFORM_ORDER = [
  "darwin-aarch64",
  "darwin-aarch64-app",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "windows-x86_64",
  "windows-x86_64-nsis",
];

function updaterPlatformsFor(name) {
  if (name.endsWith(".app.tar.gz") && name.includes("aarch64")) {
    return ["darwin-aarch64", "darwin-aarch64-app"];
  }
  if (
    name.endsWith(".app.tar.gz") &&
    !name.includes("aarch64") &&
    (name.includes("x86_64") || name.includes("x64"))
  ) {
    return ["darwin-x86_64", "darwin-x86_64-app"];
  }
  if (name.endsWith("-setup.exe")) {
    return ["windows-x86_64", "windows-x86_64-nsis"];
  }
  return [];
}

function missingReleaseAssets(names) {
  return REQUIRED_ASSET_CHECKS.filter(([, pred]) => !names.some(pred)).map(([label]) => label);
}

function buildLatestJson({ version, notes, pubDate, assets, signatures }) {
  const found = new Map();
  for (const asset of assets) {
    const keys = updaterPlatformsFor(asset.name);
    if (keys.length === 0) continue;
    const signature = signatures[asset.name];
    if (!signature) {
      throw new Error(`Missing signature for ${asset.name}`);
    }
    if (!asset.apiUrl) {
      throw new Error(`Missing GitHub asset API url for ${asset.name}`);
    }
    for (const key of keys) {
      if (found.has(key)) {
        throw new Error(`Duplicate updater asset for ${key}: ${asset.name}`);
      }
      found.set(key, { signature, url: asset.apiUrl });
    }
  }

  const platforms = {};
  for (const key of PLATFORM_ORDER) {
    const entry = found.get(key);
    if (!entry) {
      throw new Error(`Missing updater platform ${key}`);
    }
    platforms[key] = entry;
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

module.exports = {
  PLATFORM_ORDER,
  buildLatestJson,
  missingReleaseAssets,
  updaterPlatformsFor,
};
