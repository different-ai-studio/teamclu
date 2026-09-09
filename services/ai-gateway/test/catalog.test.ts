import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog, pickRoute, REQUIRED_TIERS } from "../src/catalog.js";
import { readFileSync } from "node:fs";

const ENV = { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
const SHIPPED = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);

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

test("transition aliases are priced identically to the tier they shadow", () => {
  // Phase 3 removes these. Until then a client on an old vendor id must not be
  // billed differently from one on the tier.
  const cat = parseCatalog(SHIPPED, ENV);
  assert.deepEqual(cat.public_models["deepseek-v4-flash"].pricing, cat.public_models["default"].pricing);
  assert.deepEqual(cat.public_models["deepseek-v4-pro"].pricing, cat.public_models["pro"].pricing);
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
  assert.throws(() => parseCatalog(SHIPPED, {} as NodeJS.ProcessEnv), /needs DEEPSEEK_API_KEY/);
});

// The shipped example must boot on a deployment that has supplied exactly the
// keys it names — no more, no less. It listed a provider without one once, and
// startup validation — correctly — refused to boot, which is how the gateway
// failed on its first real deploy.
//
// Derived from the catalog rather than pinned to a provider list: the point is
// the INVARIANT (every listed provider's key is required, and nothing beyond
// them is), which stays true as providers come and go. Pinning the names meant
// this test failed for the ordinary act of adding one, and a test that fails
// on correct changes gets edited until it says nothing.
test("the shipped example needs exactly the keys it lists, and each one is load-bearing", () => {
  const names = Object.values(parseCatalog(SHIPPED, ENV).providers).map((p) => p.api_key_env);
  assert.ok(names.length > 0);
  const full = Object.fromEntries(names.map((n) => [n, "k"])) as NodeJS.ProcessEnv;
  assert.deepEqual(Object.keys(parseCatalog(SHIPPED, full).providers).sort(), ["deepseek", "mx5"]);
  // Drop any single one and the gateway must refuse to start.
  for (const missing of names) {
    const partial = { ...full };
    delete partial[missing];
    assert.throws(() => parseCatalog(SHIPPED, partial), new RegExp(`needs ${missing}`), missing);
  }
});

test("refuses an unknown usage_mode", () => {
  const broken = SHIPPED.replace("usage_mode: always", "usage_mode: sometimes");
  assert.throws(() => parseCatalog(broken, ENV), /usage_mode must be/);
});

test("failover walks the route list by attempt", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  assert.equal(pickRoute(cat, "max", 0)!.backendId, "mx5-gpt-5.6-sol");
  assert.equal(pickRoute(cat, "max", 1)!.backendId, "ds-v4-pro");
  // Past the end it clamps rather than throwing.
  assert.equal(pickRoute(cat, "max", 9)!.backendId, "ds-v4-pro");
});

// The tiers are a PRODUCT contract; which vendor serves them is config. This
// pins the current wiring so a stray edit to the example cannot silently move
// paying traffic to a different model — the tier ids and prices stay put while
// the backend behind them is free to change deliberately.
test("the shipped tiers point where the deployment intends", () => {
  const cat = parseCatalog(SHIPPED, ENV);
  assert.equal(pickRoute(cat, "default", 0)!.backend.upstream_model, "deepseek-v4-flash");
  assert.equal(pickRoute(cat, "pro", 0)!.backend.upstream_model, "gpt-5.6-terra");
  assert.equal(pickRoute(cat, "max", 0)!.backend.upstream_model, "gpt-5.6-sol");
  // Both paid tiers keep a DeepSeek backstop so an mx5 outage degrades rather
  // than fails — at the same price, which is the point of pricing the tier.
  for (const tier of ["pro", "max"]) {
    assert.equal(cat.public_models[tier].routing, "failover", tier);
    assert.equal(pickRoute(cat, tier, 1)!.provider.api_base, "https://api.deepseek.com", tier);
  }
});

test("unknown public id resolves to nothing (caller turns this into 403)", () => {
  assert.equal(pickRoute(parseCatalog(SHIPPED, ENV), "gpt-9", 0), null);
});
