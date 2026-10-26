"use strict";

// Publish the TeamClu beta installers as a GitHub Release.
//
// The release is created as a draft with the installers, then latest.json is
// attached (its platform URLs are the asset API urls, which exist only after
// upload), and only then published. Official clients read
// releases/latest/download/latest.json; publishing before that file exists
// would make the updater 404.
//
// Callers must pass the workflow GITHUB_TOKEN. A tag push from that token does
// not start release.yml. release.yml also skips the nightly bump commit, so a
// PAT-created tag does not build a second official package of the same version.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildLatestJson, missingReleaseAssets, updaterPlatformsFor } = require("./lib/github-updater-manifest");

function defaultRun(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const wrapped = new Error(stderr.trim() || err.message);
    wrapped.status = err.status;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

function isNotFound(err) {
  const text = `${err.stderr || ""}\n${err.message || ""}`;
  return /not found/i.test(text) || /\b404\b/.test(text);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument ${key}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    out[key.slice(2)] = value;
  }
  for (const name of ["assets", "tag", "target", "title", "notes", "repo"]) {
    if (!out[name]) throw new Error(`Missing --${name}`);
  }
  return out;
}

function versionFromTag(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function publishGithubRelease({
  repo,
  tag,
  target,
  title,
  notesFile,
  assetsDir,
  run = defaultRun,
  now = () => new Date(),
}) {
  const names = fs.readdirSync(assetsDir).filter((name) => !name.startsWith(".") && name !== "latest.json");
  const missing = missingReleaseAssets(names);
  if (missing.length > 0) {
    throw new Error(`Missing GitHub Release assets: ${missing.join(", ")}`);
  }
  const version = versionFromTag(tag);
  const mismatched = names.filter((name) => !name.includes(version));
  if (mismatched.length > 0) {
    throw new Error(`Asset filename(s) do not contain version ${version}: ${mismatched.join(", ")}`);
  }

  let tagSha = null;
  try {
    tagSha = run(["api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"]).trim();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (tagSha && tagSha !== target) {
    throw new Error(`Tag ${tag} already points at ${tagSha}, not ${target}`);
  }

  const binaries = names.map((name) => path.join(assetsDir, name));
  let releaseExists = false;
  try {
    run(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
    releaseExists = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (!releaseExists) {
    run([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--target",
      target,
      "--title",
      title,
      "--notes-file",
      notesFile,
      "--draft",
      ...binaries,
    ]);
  } else {
    run(["release", "upload", tag, "--repo", repo, "--clobber", ...binaries]);
  }

  const listed = JSON.parse(run(["release", "view", tag, "--repo", repo, "--json", "assets"]));
  const signatures = {};
  const updaterAssets = [];
  for (const asset of listed.assets ?? []) {
    if (updaterPlatformsFor(asset.name).length === 0) continue;
    const sigPath = path.join(assetsDir, `${asset.name}.sig`);
    signatures[asset.name] = fs.readFileSync(sigPath, "utf8").trim();
    updaterAssets.push({ name: asset.name, apiUrl: asset.apiUrl });
  }
  const manifest = buildLatestJson({
    version,
    notes: fs.readFileSync(notesFile, "utf8"),
    pubDate: now().toISOString(),
    assets: updaterAssets,
    signatures,
  });
  const latestPath = path.join(assetsDir, "latest.json");
  fs.writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run(["release", "upload", tag, "--repo", repo, "--clobber", latestPath]);
  run([
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--draft=false",
    "--latest",
    "--title",
    title,
    "--notes-file",
    notesFile,
  ]);
  const url = run(["release", "view", tag, "--repo", repo, "--json", "url", "--jq", ".url"]).trim();
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `GitHub Release: ${url}\n`);
  }
  return { url, manifest };
}

function main(argv) {
  const args = parseArgs(argv);
  const { url } = publishGithubRelease({
    repo: args.repo,
    tag: args.tag,
    target: args.target,
    title: args.title,
    notesFile: args.notes,
    assetsDir: args.assets,
  });
  console.log(url);
}

module.exports = {
  isNotFound,
  parseArgs,
  publishGithubRelease,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
