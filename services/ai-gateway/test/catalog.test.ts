import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog, pickRoute, REQUIRED_TIERS } from "../src/catalog.js";
import { readFileSync } from "node:fs";

const ENV = { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
const SHIPPED = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);

// Phase 3 removed the vendor-named transition aliases, so the tier list is now
// exactly the three the desktop hardcodes — nothing wider.
test("the catalog exposes exactly the three tiers, no vendor names", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  assert.deepEqual(Object.keys(cat.public_models).sort(), ["default", "max", "pro"]);
});

test("the shipped example catalog is valid", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  for (const tier of REQUIRED_TIERS) assert.ok(cat.public_models[tier], `missing ${tier}`);
});

test("every shipped tier carries pricing (billing basis is the tier, not the backend)", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  for (const [id, m] of Object.entries(cat.public_models)) {
    assert.ok(m.pricing.input_per_1m_credits > 0, `${id} input price`);
    assert.ok(m.pricing.output_per_1m_credits > 0, `${id} output price`);
  }
});


test("refuses to start when a required tier is missing", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  delete (cat as any).public_models.pro;
  const yaml = JSON.stringify(cat); // JSON is valid YAML
  assert.throws(() => parseCatalog(yaml, ENV), /public model "pro" is required/);
});

test("refuses a route pointing at an unknown backend", () => {
  const broken = SHIPPED.replace("backend: ds-v4-flash", "backend: nope");
  assert.throws(() => parseCatalog(broken, ENV), /unknown backend nope/);
});

test("refuses to start when a provider key is absent from the environment", () => {
  assert.throws(() => parseCatalog(SHIPPED, { DEEPSEEK_API_KEY: "k" } as NodeJS.ProcessEnv),
    /needs OPENAI_API_KEY/);
});

test("refuses an unknown usage_mode", () => {
  const broken = SHIPPED.replace("usage_mode: always", "usage_mode: sometimes");
  assert.throws(() => parseCatalog(broken, ENV), /usage_mode must be/);
});

test("failover walks the route list by attempt", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  assert.equal(pickRoute(cat, "max", 0)!.backendId, "gpt-4o");
  assert.equal(pickRoute(cat, "max", 1)!.backendId, "ds-v4-pro");
  // Past the end it clamps rather than throwing.
  assert.equal(pickRoute(cat, "max", 9)!.backendId, "ds-v4-pro");
});

test("unknown public id resolves to nothing (caller turns this into 403)", () => {
  assert.equal(pickRoute(parseCatalog(SHIPPED, ENV), "gpt-9", 0), null);
});
