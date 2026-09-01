"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  keysUnderBlock,
  parseSyamlEnvVars,
  parseComposeFcEnvVars,
} = require("./env-manifest");

const repoRoot = path.resolve(__dirname, "../..");
const syamlPath = path.join(repoRoot, "services/fc/s.yaml");
const composePath = path.join(repoRoot, "deploy/self-host/docker-compose.yml");

// ─── Parser unit tests ──────────────────────────────────────────────────────
// The drift test below is only as trustworthy as the parse. A parser that
// silently returns [] would make it pass while catching nothing, so pin the
// parsing rules on fixtures too.

test("keysUnderBlock takes only keys one level under the header", () => {
  const text = ["a:", "  env:", "    FOO: 1", "    BAR: 2", "    nested:", "      DEEP: 3", "  other:", "    BAZ: 4"].join("\n");
  assert.deepStrictEqual(keysUnderBlock(text, /^ *env: *$/), ["FOO", "BAR", "nested"]);
});

test("keysUnderBlock skips comments and blank lines", () => {
  const text = ["env:", "  # a comment", "", "  FOO: 1"].join("\n");
  assert.deepStrictEqual(keysUnderBlock(text, /^ *env: *$/), ["FOO"]);
});

test("keysUnderBlock returns null when the block is absent", () => {
  assert.strictEqual(keysUnderBlock("a:\n  b: 1", /^ *env: *$/), null);
});

test("parseSyamlEnvVars keeps digits in names (APNS_PRIVATE_KEY_P8)", () => {
  const text = ["      environmentVariables:", "        APNS_PRIVATE_KEY_P8: x", "        BUCKET: y"].join("\n");
  assert.deepStrictEqual(parseSyamlEnvVars(text), ["APNS_PRIVATE_KEY_P8", "BUCKET"]);
});

test("parseComposeFcEnvVars reads the fc service, not another service's environment", () => {
  const text = [
    "services:",
    "  ai-gateway:",
    "    environment:",
    "      NOT_FC: 1",
    "  fc:",
    "    environment:",
    "      PORT: '9000'",
    "      SUPABASE_URL: x",
    "  caddy:",
    "    environment:",
    "      ALSO_NOT_FC: 1",
  ].join("\n");
  assert.deepStrictEqual(parseComposeFcEnvVars(text), ["PORT", "SUPABASE_URL"]);
});

// ─── The drift check ────────────────────────────────────────────────────────

/**
 * Declared in s.yaml, deliberately NOT in the compose fc allowlist. Each entry
 * is a decision, not an oversight — the reason is the point of the list.
 */
const INTENTIONAL_FC_ONLY = {
  // Must NOT be set on self-host — passing these through would cause the bug.
  CORS_HANDLED_BY_PROXY: "MUST stay unset: Caddy adds no CORS headers, Hono must own CORS",

  // Features that are correctly unreachable on self-host.

  // Adding this would fix nothing: the DB trigger that calls /push/dispatch
  // hardcodes https://cloud.ucar.cc and short-circuits on an unseeded vault
  // secret, so the webhook never reaches a self-host box in the first place.
};

/**
 * Declared in s.yaml, missing from compose, and that IS a bug. Listed so the
 * drift test passes on today's tree while still naming these as gaps rather
 * than blessing them as intentional. Fix by adding to the compose fc
 * environment map and deleting the entry here.
 */
const KNOWN_GAPS = {};

/** In the compose fc allowlist and deliberately not in s.yaml. */
const INTENTIONAL_COMPOSE_ONLY = {
  PORT: "container listens on a port; FC invokes a handler instead",
  HOST: "container bind address; not a thing under FC",
};

function readVars() {
  const syaml = parseSyamlEnvVars(fs.readFileSync(syamlPath, "utf8"));
  const compose = parseComposeFcEnvVars(fs.readFileSync(composePath, "utf8"));
  assert.ok(syaml, `no environmentVariables: block found in ${syamlPath}`);
  assert.ok(compose, `no fc environment: block found in ${composePath}`);
  // Guard against a parser regression quietly emptying either side.
  assert.ok(syaml.length > 20, `parsed only ${syaml.length} vars from s.yaml — parser likely broken`);
  assert.ok(compose.length > 20, `parsed only ${compose.length} vars from compose — parser likely broken`);
  for (const shared of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MQTT_BROKER_URL"]) {
    assert.ok(syaml.includes(shared), `expected ${shared} in s.yaml — parser likely broken`);
    assert.ok(compose.includes(shared), `expected ${shared} in compose — parser likely broken`);
  }
  return { syaml: new Set(syaml), compose: new Set(compose) };
}

test("every s.yaml var is either in the compose fc allowlist or documented as FC-only", () => {
  const { syaml, compose } = readVars();
  const undocumented = [...syaml].filter(
    (v) => !compose.has(v) && !(v in INTENTIONAL_FC_ONLY) && !(v in KNOWN_GAPS)
  );
  assert.deepStrictEqual(
    undocumented,
    [],
    `${undocumented.join(", ")} reach Function Compute but not self-host.\n` +
      `Either add them to the fc service's environment: map in deploy/self-host/docker-compose.yml,\n` +
      `or document why they are FC-only in INTENTIONAL_FC_ONLY / KNOWN_GAPS in this file.`
  );
});

test("every compose fc var is either in s.yaml or documented as compose-only", () => {
  const { syaml, compose } = readVars();
  const undocumented = [...compose].filter(
    (v) => !syaml.has(v) && !(v in INTENTIONAL_COMPOSE_ONLY)
  );
  assert.deepStrictEqual(
    undocumented,
    [],
    `${undocumented.join(", ")} reach self-host but not Function Compute.\n` +
      `Either add them to environmentVariables: in services/fc/s.yaml,\n` +
      `or document why they are self-host-only in INTENTIONAL_COMPOSE_ONLY in this file.`
  );
});

test("the documented divergence lists carry no stale entries", () => {
  // A var that got wired into both sides (or deleted) must be removed from the
  // lists, or they rot into folklore that outlives the reason.
  const { syaml, compose } = readVars();
  for (const v of [...Object.keys(INTENTIONAL_FC_ONLY), ...Object.keys(KNOWN_GAPS)]) {
    assert.ok(syaml.has(v), `${v} is listed as FC-only but is no longer in s.yaml — drop it from the list`);
    assert.ok(!compose.has(v), `${v} is listed as FC-only but is now in compose — drop it from the list`);
  }
  for (const v of Object.keys(INTENTIONAL_COMPOSE_ONLY)) {
    assert.ok(compose.has(v), `${v} is listed as compose-only but is no longer in compose — drop it from the list`);
    assert.ok(!syaml.has(v), `${v} is listed as compose-only but is now in s.yaml — drop it from the list`);
  }
});
