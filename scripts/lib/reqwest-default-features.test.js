"use strict";

// Guardrail: every direct reqwest declaration in the repo must be
// default-features = false with a rustls-tls-* feature.
//
// Why: release-oss builds amuxd and teamclu-introspect in ONE cargo
// invocation, so reqwest's features unify across the selection. One crate
// leaving reqwest's `default` on merges native-tls into the union, and
// reqwest then defaults Client::new() to native-tls instead of rustls — the
// beta.63 /v1/auth/refresh breakage. scripts/verify-reqwest-rustls.sh gates
// the resolved unified graph in CI and before every release build; this test
// guards the manifests themselves, including crates no gate resolves today
// (autoui-mcp builds standalone).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

const SKIP_DIRS = new Set(["node_modules", "target", "binaries", "dist"]);

function findCargoTomls(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === "Cargo.toml") out.push(path.join(dir, entry.name));
      continue;
    }
    // Dot dirs (.git, .cargo-target, local scratch dirs) never carry a
    // manifest this policy applies to.
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    out.push(...findCargoTomls(path.join(dir, entry.name)));
  }
  return out;
}

const declarations = [];
const violations = [];

for (const file of findCargoTomls(repoRoot).sort()) {
  const rel = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // Dotted workspace inheritance (`reqwest.workspace = true`): the features
    // come from [workspace.dependencies], and the workspace root Cargo.toml
    // is scanned by this same test — the source of truth is covered there.
    if (/^\s*reqwest\.workspace\s*=\s*true\s*$/.test(line)) return;

    const match = line.match(/^\s*reqwest\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!match) return;
    const where = `${rel}:${i + 1}`;
    declarations.push(where);
    const value = match[1];

    // `reqwest = "0.12"` — no inline table, so no way to turn defaults off.
    if (!value.startsWith("{")) {
      violations.push(
        `${where}: reqwest declared without an inline table — default features (native-tls) are on: ${line.trim()}`,
      );
      return;
    }

    if (/\bworkspace\s*=\s*true\b/.test(value)) return;

    if (!/\bdefault-features\s*=\s*false\b/.test(value)) {
      violations.push(
        `${where}: missing default-features = false — reqwest's default merges native-tls into unified builds: ${line.trim()}`,
      );
    }
    if (!/"rustls-tls[a-z-]*"/.test(value)) {
      violations.push(
        `${where}: no rustls-tls-* feature — reqwest would ship without a TLS backend: ${line.trim()}`,
      );
    }
  });
}

test("every direct reqwest declaration is default-features = false with a rustls feature", () => {
  // Floor, not an exact count: proves the scan found the known manifests so
  // the test cannot pass vacuously. Lower it only when a crate is removed.
  assert.ok(
    declarations.length >= 5,
    `expected at least 5 reqwest declarations, scanned: ${declarations.join(", ")}`,
  );
  assert.deepEqual(violations, []);
});

test("release-oss gates the unified sidecar reqwest graph before building", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github/workflows/release-oss.yml"),
    "utf8",
  );
  // Count run-lines, not mentions: step comments reference the script by
  // name too, and only the runs are the gate.
  const gates = [...workflow.matchAll(/run: \.\/scripts\/verify-reqwest-rustls\.sh/g)].map((m) => m.index);
  const macBuild = workflow.indexOf("Build all (parallel)");
  const winBuild = workflow.indexOf("Build frontend + sidecars (parallel)");
  assert.ok(
    macBuild > 0 && winBuild > macBuild,
    "build-step anchors missing — update this test when the release steps are renamed",
  );
  assert.equal(gates.length, 2, "both build-macos and build-windows must run the gate");
  assert.ok(gates[0] < macBuild, "build-macos gate must precede its unified sidecar build");
  assert.ok(
    gates[1] > macBuild && gates[1] < winBuild,
    "build-windows gate must precede its unified sidecar build",
  );
});

test("the gate script resolves the release's exact package selection, and CI runs it", () => {
  const script = fs.readFileSync(
    path.join(repoRoot, "scripts/verify-reqwest-rustls.sh"),
    "utf8",
  );
  assert.match(script, /--locked/);
  assert.match(script, /-p amuxd -p teamclu-introspect/);

  const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /verify-reqwest-rustls\.sh/);
});
