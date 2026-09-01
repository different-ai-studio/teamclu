/**
 * The Cloud API ships to two targets from one source tree: the self-host
 * container (deploy/self-host/docker-compose.yml) and Alibaba Function Compute
 * (services/fc/s.yaml). Compose's `environment:` map is an ALLOWLIST — a
 * variable absent from it never reaches the container, no matter what the
 * box's .env says — so a var added to only one target silently disables the
 * feature on the other, with no error anywhere.
 *
 * That has bitten this repo repeatedly: the $1 LiteLLM budget cap, and the
 * whole apps module (APPS_DB_ADMIN_URL / CODEUP_* declared only in s.yaml, so
 * every app deploy answered 503 `deploy_unavailable`). These tests pin the two
 * lists together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FC_DIR = path.resolve(here, "..");
const REPO = path.resolve(FC_DIR, "../..");

/**
 * Variables that legitimately exist on one target only. Every entry needs a
 * reason — "it was already like that" is not one.
 */
const EXPECTED_ONLY_IN_COMPOSE = new Set([
  // The container listens on these; FC's runtime supplies its own.
  "PORT",
  "HOST",
]);
const EXPECTED_ONLY_IN_S_YAML = new Set([
  // Self-host runs behind Caddy, which is a transparent proxy that adds no
  // CORS headers, so Hono must own CORS there. Setting this on self-host would
  // strip CORS entirely (services/fc/src/app.ts).
  "CORS_HANDLED_BY_PROXY",
]);

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

function sYamlEnvKeys(): Set<string> {
  return keysUnder(path.join(FC_DIR, "s.yaml"), "      environmentVariables:", 8);
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

test("both deploy targets declare the same environment", () => {
  const sYaml = sYamlEnvKeys();
  const compose = composeFcEnvKeys();

  const onlyCompose = [...compose].filter((k) => !sYaml.has(k) && !EXPECTED_ONLY_IN_COMPOSE.has(k));
  const onlySYaml = [...sYaml].filter((k) => !compose.has(k) && !EXPECTED_ONLY_IN_S_YAML.has(k));

  assert.deepEqual(
    onlySYaml.sort(),
    [],
    "declared in s.yaml but missing from the compose allowlist — the self-host " +
      "container will never receive these, so the features are silently off",
  );
  assert.deepEqual(
    onlyCompose.sort(),
    [],
    "declared in compose but missing from s.yaml — the FC target will never " +
      "receive these",
  );
});

test("the exception lists stay honest", () => {
  const sYaml = sYamlEnvKeys();
  const compose = composeFcEnvKeys();
  for (const k of EXPECTED_ONLY_IN_COMPOSE) {
    assert.ok(compose.has(k), `${k} is listed as compose-only but is not in compose`);
    assert.ok(!sYaml.has(k), `${k} is now in s.yaml too — drop it from the exception list`);
  }
  for (const k of EXPECTED_ONLY_IN_S_YAML) {
    assert.ok(sYaml.has(k), `${k} is listed as s.yaml-only but is not in s.yaml`);
    assert.ok(!compose.has(k), `${k} is now in compose too — drop it from the exception list`);
  }
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
        for (const m of src.matchAll(/\benvValue\(["']([A-Z_0-9]+)["']\)/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(FC_DIR, "src"));
  return found;
}

test("no deploy target declares a variable nothing reads", () => {
  // Catches the typo class: s.yaml shipped OTP_EMAIL_SMTP_FROM for months while
  // the code read OTP_EMAIL_FROM, so the configured From address did nothing.
  const read = envVarsReadBySource();
  const declared = new Set([...sYamlEnvKeys(), ...composeFcEnvKeys()]);
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
