"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildLatestJson, missingReleaseAssets } = require("./github-updater-manifest");
const { stageGithubReleaseAssets } = require("./stage-github-release-assets");
const { publishGithubRelease } = require("../publish-teamclu-github-release");

const VERSION = "0.4.1-beta.103";
const NAMES = [
  `TeamClu_${VERSION}_aarch64.app.tar.gz`,
  `TeamClu_${VERSION}_aarch64.app.tar.gz.sig`,
  `TeamClu_${VERSION}_aarch64.dmg`,
  `TeamClu_${VERSION}_x64.app.tar.gz`,
  `TeamClu_${VERSION}_x64.app.tar.gz.sig`,
  `TeamClu_${VERSION}_x64.dmg`,
  `TeamClu_${VERSION}_x64-setup.exe`,
  `TeamClu_${VERSION}_x64-setup.exe.sig`,
];

function signatureFor(name) {
  return `sig:${name}`;
}

test("missingReleaseAssets names every installer the GitHub Release page carries", () => {
  assert.deepEqual(missingReleaseAssets([]).length, 8);
  assert.deepEqual(missingReleaseAssets(NAMES), []);
});

test("buildLatestJson points both updater aliases at the same asset API url", () => {
  const assets = NAMES.filter((name) => !name.endsWith(".sig") && !name.endsWith(".dmg")).map(
    (name, index) => ({
      name,
      apiUrl: `https://api.github.com/repos/different-ai-studio/teamclu/releases/assets/${index + 1}`,
    }),
  );
  const signatures = Object.fromEntries(assets.map((asset) => [asset.name, signatureFor(asset.name)]));
  const manifest = buildLatestJson({
    version: VERSION,
    notes: "notes",
    pubDate: "2026-10-26T00:00:00.000Z",
    assets,
    signatures,
  });

  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.platforms["darwin-aarch64"].url, assets[0].apiUrl);
  assert.equal(manifest.platforms["darwin-aarch64-app"].url, assets[0].apiUrl);
  assert.equal(manifest.platforms["darwin-x86_64"].signature, signatureFor(assets[1].name));
  assert.equal(manifest.platforms["windows-x86_64"].url, manifest.platforms["windows-x86_64-nsis"].url);
  assert.deepEqual(Object.keys(manifest.platforms), [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "windows-x86_64",
    "windows-x86_64-nsis",
  ]);
});

test("stageGithubReleaseAssets copies dmg, updater, and setup exe with spaces removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-stage-"));
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(path.join(bundle, "dmg"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "macos"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "dmg", "Team Clu.dmg"), "dmg");
  fs.writeFileSync(path.join(bundle, "macos", "Team Clu.app.tar.gz"), "tar");
  fs.writeFileSync(path.join(bundle, "macos", "Team Clu.app.tar.gz.sig"), "sig");
  fs.writeFileSync(path.join(bundle, "nsis", "Team Clu-setup.exe"), "exe");
  fs.writeFileSync(path.join(bundle, "nsis", "Team Clu-setup.exe.sig"), "sig");
  fs.writeFileSync(path.join(bundle, "nsis", "ignore.msi"), "msi");

  const staged = stageGithubReleaseAssets(bundle, path.join(root, "out"));
  assert.deepEqual(staged, [
    "Team_Clu-setup.exe",
    "Team_Clu-setup.exe.sig",
    "Team_Clu.app.tar.gz",
    "Team_Clu.app.tar.gz.sig",
    "Team_Clu.dmg",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of NAMES) {
    const body = name.endsWith(".sig") ? signatureFor(name.slice(0, -4)) : "bytes";
    fs.writeFileSync(path.join(dir, name), body);
  }
}

function notFound() {
  const err = new Error("Not Found (HTTP 404)");
  err.stderr = "gh: Not Found (HTTP 404)";
  err.status = 1;
  return err;
}

test("publishGithubRelease creates a draft, attaches latest.json, then publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-pub-"));
  const assetsDir = path.join(root, "assets");
  writeAssets(assetsDir);
  const notesFile = path.join(root, "notes.md");
  fs.writeFileSync(notesFile, "install notes");
  const calls = [];
  const target = "c67432208d95369a578991cb8b944d697f927aa2";

  const { url, manifest } = publishGithubRelease({
    repo: "different-ai-studio/teamclu",
    tag: `v${VERSION}`,
    target,
    title: `TeamClu v${VERSION}`,
    notesFile,
    assetsDir,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    run(args) {
      calls.push(args);
      if (args[0] === "api") throw notFound();
      if (args[1] === "view" && args.includes("tagName")) throw notFound();
      if (args[1] === "view" && args.includes("assets")) {
        return JSON.stringify({
          assets: NAMES.filter((name) => !name.endsWith(".sig")).map((name, index) => ({
            name,
            apiUrl: `https://api.github.com/repos/different-ai-studio/teamclu/releases/assets/${index + 10}`,
          })),
        });
      }
      if (args[1] === "view" && args.includes("url")) {
        return `https://github.com/different-ai-studio/teamclu/releases/tag/v${VERSION}\n`;
      }
      return "";
    },
  });

  assert.equal(url, `https://github.com/different-ai-studio/teamclu/releases/tag/v${VERSION}`);
  assert.equal(calls[0][0], "api");
  assert.equal(calls[1][1], "view");
  assert.equal(calls[2][1], "create");
  assert.ok(calls[2].includes("--draft"));
  assert.ok(calls[2].includes("--target"));
  assert.ok(calls[2].includes(target));
  const latestUpload = calls.find(
    (args) => args[1] === "upload" && args.some((arg) => String(arg).endsWith("latest.json")),
  );
  assert.ok(latestUpload);
  const publish = calls.find((args) => args.includes("--draft=false"));
  assert.ok(publish);
  assert.ok(publish.includes("--latest"));
  assert.ok(calls.indexOf(latestUpload) < calls.indexOf(publish));
  assert.equal(manifest.platforms["darwin-aarch64"].signature, signatureFor(`TeamClu_${VERSION}_aarch64.app.tar.gz`));
  const written = JSON.parse(fs.readFileSync(path.join(assetsDir, "latest.json"), "utf8"));
  assert.equal(written.version, VERSION);
  fs.rmSync(root, { recursive: true, force: true });
});

test("publishGithubRelease refuses a tag that already points at another commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-tag-"));
  const assetsDir = path.join(root, "assets");
  writeAssets(assetsDir);
  const notesFile = path.join(root, "notes.md");
  fs.writeFileSync(notesFile, "notes");
  const calls = [];
  assert.throws(
    () =>
      publishGithubRelease({
        repo: "different-ai-studio/teamclu",
        tag: `v${VERSION}`,
        target: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        title: "TeamClu",
        notesFile,
        assetsDir,
        run(args) {
          calls.push(args);
          if (args[0] === "api") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
          throw new Error(`unexpected ${args.join(" ")}`);
        },
      }),
    /already points at/,
  );
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("publishGithubRelease uploads onto an existing release without creating a second one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-existing-"));
  const assetsDir = path.join(root, "assets");
  writeAssets(assetsDir);
  const notesFile = path.join(root, "notes.md");
  fs.writeFileSync(notesFile, "notes");
  const target = "cccccccccccccccccccccccccccccccccccccccc";
  const calls = [];
  publishGithubRelease({
    repo: "different-ai-studio/teamclu",
    tag: `v${VERSION}`,
    target,
    title: `TeamClu v${VERSION}`,
    notesFile,
    assetsDir,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    run(args) {
      calls.push(args);
      if (args[0] === "api") return `${target}\n`;
      if (args[1] === "view" && args.includes("assets")) {
        return JSON.stringify({
          assets: NAMES.filter((name) => !name.endsWith(".sig")).map((name, index) => ({
            name,
            apiUrl: `https://api.github.com/repos/acme/teamclu/releases/assets/${index + 1}`,
          })),
        });
      }
      if (args[1] === "view" && args.includes("url")) return "https://github.com/acme/teamclu/releases/tag/v0\n";
      return "";
    },
  });
  assert.equal(calls.some((args) => args[1] === "create"), false);
  assert.ok(calls.some((args) => args[1] === "upload" && args.includes("--clobber")));
  fs.rmSync(root, { recursive: true, force: true });
});
