"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "scripts", "finalize-oss-release-conf.py");

// The Windows release runner's Python opens text files in cp1252 unless told
// otherwise. That is the whole bug (#1403): "TeamClu 群策" went in as UTF-8,
// was read back as "TeamClu ç¾¤ç­–" without an error — none of its bytes hit
// the five cp1252 leaves undefined — and was written out that way, so the
// Windows build baked a mojibake window title. macOS defaults to UTF-8 and
// never showed it, so this shim puts the Windows default on every platform.
const CP1252_DEFAULT_OPEN = `
import builtins, runpy, sys
_open = builtins.open
def _cp1252_default(file, mode="r", *args, **kwargs):
    if "b" not in mode and kwargs.get("encoding") is None and len(args) < 3:
        kwargs["encoding"] = "cp1252"
    return _open(file, mode, *args, **kwargs)
builtins.open = _cp1252_default
sys.argv = [sys.argv[1]]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-oss-conf-"));
  writeJson(path.join(dir, "apps/desktop/tauri.conf.json"), {
    productName: "TeamClu",
    version: "0.0.0",
    build: { beforeBuildCommand: "pnpm build" },
    app: { windows: [{ title: "TeamClu 群策" }] },
  });
  for (const crate of ["apps/desktop", "apps/daemon"]) {
    fs.mkdirSync(path.join(dir, crate), { recursive: true });
    fs.writeFileSync(
      path.join(dir, crate, "Cargo.toml"),
      '[package]\nname = "x"\nversion = "0.0.0"\n',
      "utf8",
    );
  }
  writeJson(path.join(dir, "package.json"), { name: "teamclu", version: "0.0.0" });
  writeJson(path.join(dir, "build.config.json"), {
    app: { name: "TeamClu", displayName: "TeamClu 群策" },
  });
  return dir;
}

test("finalize-oss-release-conf keeps a Chinese brand name intact under a cp1252 default", () => {
  const dir = fixture();
  try {
    execFileSync("python3", ["-c", CP1252_DEFAULT_OPEN, script], {
      cwd: dir,
      env: {
        ...process.env,
        PYTHONUTF8: "0",
        TAG: "v1.2.3-beta.4",
        CDN_BASE: "https://cdn.example.com/",
        OSS_PREFIX: "beta",
      },
      stdio: "pipe",
    });

    const conf = readJson(path.join(dir, "apps/desktop/tauri.conf.json"));
    assert.equal(conf.app.windows[0].title, "TeamClu 群策");
    assert.equal(conf.version, "1.2.3-beta.4");
    assert.deepEqual(conf.plugins.updater.endpoints, [
      "https://cdn.example.com/beta/latest.json",
    ]);

    // build.rs turns this into APP_DISPLAY_NAME — the tray tooltip and the
    // name handed to the bundled amuxd — so it has to survive too.
    const buildConfig = readJson(path.join(dir, "build.config.json"));
    assert.equal(buildConfig.app.displayName, "TeamClu 群策");
    assert.deepEqual(buildConfig.app.updater.endpoints, [
      "https://cdn.example.com/beta/latest.json",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
