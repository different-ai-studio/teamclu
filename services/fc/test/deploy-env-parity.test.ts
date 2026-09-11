/**
 * The Cloud API ships to two container targets from one source tree: self-host
 * (deploy/self-host/docker-compose.yml) and Belayo Dokploy
 * (deploy/belayo/cloud-api.env.keys). Both targets' environments are an
 * ALLOWLIST — a
 * variable absent from it never reaches the container, no matter what the
 * host configuration says — so a var added to only one target silently
 * disables the feature there, with no error anywhere.
 *
 * These tests pin the two lists together so a feature cannot silently exist in
 * only one environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FC_DIR = path.resolve(here, "..");
const REPO = path.resolve(FC_DIR, "../..");
const BELAYO_ENV_FILE = path.join(REPO, "deploy/belayo/cloud-api.env.keys");
const BELAYO_WORKFLOW = path.join(REPO, ".github/workflows/belayo-cloud-api.yml");

/**
 * Collect `KEY:` names nested under `blockHeader` in a YAML file.
 *
 * Line-based on purpose: matching a YAML block with one regex needs an
 * end-of-block lookahead, and the obvious `\Z` is not a JS anchor — it silently
 * matches a literal "Z", so the block is never found and the test passes
 * vacuously. Walking lines by indent has no such trap.
 */
function keysUnder(file: string, blockHeader: string, keyIndent: number): Set<string> {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const headerIndent = blockHeader.length - blockHeader.trimStart().length;
  const start = lines.findIndex((l) => l === blockHeader || l.trimEnd() === blockHeader.trimEnd());
  assert.ok(start >= 0, `${path.basename(file)}: block "${blockHeader.trim()}" not found`);

  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= headerIndent) break; // dedented out of the block
    if (indent !== keyIndent) continue; // nested value, not a key of this block
    const m = /^([A-Z_0-9]+):/.exec(line.trim());
    if (m) keys.add(m[1]);
  }
  assert.ok(keys.size > 0, `${path.basename(file)}: no keys under "${blockHeader.trim()}"`);
  return keys;
}

function composeFcEnvKeys(): Set<string> {
  // The compose file has several `environment:` blocks; the fc service's is the
  // one whose keys include the service's own PORT.
  const file = path.join(REPO, "deploy/self-host/docker-compose.yml");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const fcIndex = lines.findIndex((l) => l === "  fc:");
  assert.ok(fcIndex >= 0, "docker-compose.yml: fc service not found");
  const end = lines.findIndex((l, i) => i > fcIndex && /^ {2}\S/.test(l));
  const block = lines.slice(fcIndex, end === -1 ? undefined : end);

  const envIndex = block.findIndex((l) => l.trimEnd() === "    environment:");
  assert.ok(envIndex >= 0, "docker-compose.yml: fc environment block not found");
  const keys = new Set<string>();
  for (const line of block.slice(envIndex + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < 6) break;
    if (indent !== 6) continue;
    const m = /^([A-Z_0-9]+):/.exec(line.trim());
    if (m) keys.add(m[1]);
  }
  assert.ok(keys.size > 0, "docker-compose.yml: no env keys for the fc service");
  return keys;
}

function namesOnlyEnvKeys(file: string): Set<string> {
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const row of rows) {
    assert.match(row, /^[A-Z][A-Z_0-9]*$/, `${path.basename(file)}: invalid key ${row}`);
  }
  assert.equal(new Set(rows).size, rows.length, `${path.basename(file)}: duplicate keys`);
  assert.deepEqual(rows, [...rows].sort(), `${path.basename(file)}: keys must stay sorted`);
  return new Set(rows);
}

function belayoEnvKeys(): Set<string> {
  return namesOnlyEnvKeys(BELAYO_ENV_FILE);
}

test("Belayo Dokploy and self-host declare the same Cloud API environment", () => {
  const belayo = belayoEnvKeys();
  const compose = composeFcEnvKeys();
  const onlyCompose = [...compose].filter((key) => !belayo.has(key));
  const onlyBelayo = [...belayo].filter((key) => !compose.has(key));

  // Self-host uses this selector to choose bundled vs external Supabase.
  assert.deepEqual(onlyCompose.sort(), ["FC_SUPABASE_URL"]);
  assert.deepEqual(
    onlyBelayo.sort(),
    [],
    "declared for Belayo Dokploy but missing from the self-host allowlist",
  );
});

/**
 * Every environment variable the service reads.
 *
 * Three access shapes are in use: `process.env.FOO` directly, `env.FOO` on an
 * injected `env` object (publishableKeyFromEnv), and `envValue("FOO")` — the
 * blank-is-absent reader in routes/config.ts. Matching only some would report
 * live variables as dead.
 */
function envVarsReadBySource(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/process\.env\.([A-Z_0-9]+)/g)) found.add(m[1]);
        for (const m of src.matchAll(/process\.env\[["']([A-Z_0-9]+)["']\]/g)) found.add(m[1]);
        for (const m of src.matchAll(/\benv\.([A-Z_0-9]+)/g)) found.add(m[1]);
        for (const m of src.matchAll(/\benv\[["']([A-Z_0-9]+)["']\]/g)) found.add(m[1]);
        for (const m of src.matchAll(/\benvValue\(["']([A-Z_0-9]+)["'](?:\s*,[^)]*)?\)/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(FC_DIR, "src"));
  return found;
}

test("no deploy target declares a variable nothing reads", () => {
  // Catches the typo class where a manifest key differs from what source reads,
  // so a configured value silently does nothing.
  const read = envVarsReadBySource();
  const declared = new Set([...composeFcEnvKeys(), ...belayoEnvKeys()]);
  // Consumed by the runtime/toolchain rather than by our own source.
  const RUNTIME_OWNED = new Set(["PORT", "HOST", "NODE_ENV"]);
  const orphans = [...declared].filter((k) => !read.has(k) && !RUNTIME_OWNED.has(k));
  assert.deepEqual(orphans.sort(), [], "declared for deployment but never read by src/");
});

/** Every `${VAR}` / `${VAR:-default}` the self-host compose file interpolates. */
function composeVarRefs(): Set<string> {
  const text = fs.readFileSync(path.join(REPO, "deploy/self-host/docker-compose.yml"), "utf8");
  return new Set([...text.matchAll(/\$\{([A-Z_0-9]+)(?::-[^}]*)?\}/g)].map((m) => m[1]));
}

test("every variable compose reads is documented in .env.example", () => {
  // Compose silently interpolates an unset variable to the empty string, so an
  // undocumented one is a feature the operator has no way to discover: it is
  // not in the template, not in any error, and the feature is just off.
  const documented = new Set(
    [
      ...fs
        .readFileSync(path.join(REPO, "deploy/self-host/.env.example"), "utf8")
        .matchAll(/^#?\s*([A-Z_0-9]+)=/gm),
    ].map((m) => m[1]),
  );
  const undocumented = [...composeVarRefs()].filter((k) => !documented.has(k));
  assert.deepEqual(undocumented.sort(), [], "read by docker-compose.yml but absent from .env.example");
});

test("Belayo Cloud API deploy keeps database migrations manual", () => {
  const workflow = fs.readFileSync(BELAYO_WORKFLOW, "utf8");
  const executableWorkflow = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.match(workflow, /services\/fc\/\*\*/);
  assert.doesNotMatch(executableWorkflow, /services\/supabase\/migrations/i);
  assert.doesNotMatch(executableWorkflow, /apply[-_]migrations/i);
  assert.doesNotMatch(executableWorkflow, /_selfhost\.schema_migrations/i);
  assert.doesNotMatch(executableWorkflow, /supabase\s+(?:db\s+push|migration\s+up)/i);
});
