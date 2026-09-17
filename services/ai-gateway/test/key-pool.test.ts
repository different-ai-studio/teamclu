import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseApiKeys, parseCatalog } from "../src/catalog.js";
import { KeyPools, classifyUpstream, cooldownMs, retryAfterMs } from "../src/key-pool.js";

const CATALOG_YAML = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);

test("a key variable holds one key or several", () => {
  assert.deepEqual(parseApiKeys("sk-a"), ["sk-a"]);
  assert.deepEqual(parseApiKeys("sk-a,sk-b"), ["sk-a", "sk-b"]);
  assert.deepEqual(parseApiKeys(" sk-a , sk-b\nsk-c "), ["sk-a", "sk-b", "sk-c"]);
  assert.deepEqual(parseApiKeys("sk-a,sk-a"), ["sk-a"], "one account listed twice is not two accounts");
  assert.deepEqual(parseApiKeys(" , "), []);
  assert.deepEqual(parseApiKeys(undefined), []);
});

test("a catalog whose key variable holds only separators refuses to start", () => {
  assert.throws(
    () => parseCatalog(CATALOG_YAML, { DEEPSEEK_API_KEY: " , ", OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv),
    /needs DEEPSEEK_API_KEY/,
  );
});

const h = (headers: Record<string, string> = {}) => new Headers(headers);
const cls = (status: number, text: string, headers?: Record<string, string>) => {
  const v = classifyUpstream(status, h(headers), text);
  return v.kind === "key" ? `${v.failure.class}/${v.failure.scope}` : v.kind;
};

test("error responses are sorted by whose problem they are", () => {
  assert.equal(cls(401, "invalid api key"), "invalid/key");
  assert.equal(cls(402, '{"error":{"message":"Insufficient Balance"}}'), "exhausted/key");
  assert.equal(cls(500, "boom"), "route");
  assert.equal(cls(503, "overloaded"), "route");
  for (const status of [400, 403, 404, 413, 422]) assert.equal(cls(status, "nope"), "caller", String(status));
});

test("a 429 is a quota when its text says so, and a throttle otherwise", () => {
  // Plain throttles — including OpenAI's, which says "limit reached".
  assert.equal(cls(429, '{"error":{"message":"Rate limit reached for requests"}}'), "rate_limited/model");
  assert.equal(cls(429, "Too Many Requests"), "rate_limited/model");
  // Quotas, in the shapes providers actually send.
  for (const text of [
    '{"error":{"code":"insufficient_quota"}}',
    '{"error":{"code":"credit_balance_exhausted"}}',
    '{"error":{"code":"organization_spend_limit_exceeded"}}',
    '{"error":{"type":"usage_limit_reached"}}',
    '{"type":"error","error":{"type":"GoUsageLimitError"}}',
    "weekly usage limit reached. It will reset in 5 days 10 hours",
    '{"error":{"type":"exceeded_current_quota_error"}}',
  ]) {
    assert.equal(cls(429, text), "exhausted/model", text);
  }
});

test("a long Retry-After makes a 429 a quota whatever the body says", () => {
  assert.equal(cls(429, "slow down", { "retry-after": "3600" }), "exhausted/model");
  assert.equal(cls(429, "slow down", { "retry-after": "20" }), "rate_limited/model");
});

test("Retry-After is read as seconds or as a date", () => {
  assert.equal(retryAfterMs("30"), 30_000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2015 07:28:10 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")), 10_000);
  assert.equal(retryAfterMs("soon"), undefined);
  assert.equal(retryAfterMs(""), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

test("an exhausted key backs off 1, 2, 4 … minutes and stops at 30", () => {
  const f = { class: "exhausted", scope: "key" } as const;
  const minutes = [1, 2, 3, 4, 5, 6, 7].map((s) => cooldownMs(f, s) / 60_000);
  assert.deepEqual(minutes, [1, 2, 4, 8, 16, 30, 30]);
});

test("a Retry-After can shorten an exhausted cooldown but never lengthen it", () => {
  // The Go outage answered every account with ~10h; honouring it would bench a
  // whole pool long after the service came back (opencode #47613).
  assert.equal(cooldownMs({ class: "exhausted", scope: "model", hintMs: 10 * 3600_000 }, 1), 60_000);
  assert.equal(cooldownMs({ class: "exhausted", scope: "model", hintMs: 20_000 }, 1), 20_000);
});

test("a throttle cools for its Retry-After, bounded to between a second and a minute", () => {
  assert.equal(cooldownMs({ class: "rate_limited", scope: "model" }, 1), 10_000);
  assert.equal(cooldownMs({ class: "rate_limited", scope: "model", hintMs: 5_000 }, 9), 5_000);
  assert.equal(cooldownMs({ class: "rate_limited", scope: "model", hintMs: 0 }, 1), 1_000);
  assert.equal(cooldownMs({ class: "rate_limited", scope: "model", hintMs: 600_000 }, 1), 60_000);
});

function pools(keys: string, clock = () => 0) {
  const env = { DEEPSEEK_API_KEY: keys, OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv;
  return new KeyPools(parseCatalog(CATALOG_YAML, env), env, clock);
}
const secrets = (p: KeyPools, model = "m") => p.candidates("deepseek", model).map((k) => k.secret);
const detail = { status: 0, error: "" };

test("candidates come in priority order, benched keys left out", () => {
  const p = pools("a1,b2,c3");
  assert.deepEqual(secrets(p), ["a1", "b2", "c3"]);
  const [a] = p.candidates("deepseek", "m");
  p.failed(a, "m", { class: "exhausted", scope: "key" }, detail);
  assert.deepEqual(secrets(p), ["b2", "c3"]);
});

test("strikes count consecutive failures of one class, and a success wipes them", () => {
  let now = 0;
  const p = pools("a1", () => now);
  const [a] = p.candidates("deepseek", "m");
  assert.equal(p.failed(a, "m", { class: "exhausted", scope: "key" }, detail).strikes, 1);
  now += 61_000;
  assert.equal(p.failed(a, "m", { class: "exhausted", scope: "key" }, detail).strikes, 2);
  now += 121_000;
  p.succeeded(a, "m");
  assert.equal(p.failed(a, "m", { class: "exhausted", scope: "key" }, detail).strikes, 1);
});

test("a success clears the whole-key bench and this model's, not another model's", () => {
  let now = 0;
  const p = pools("a1", () => now);
  const [a] = p.candidates("deepseek", "flash");
  p.failed(a, "flash", { class: "exhausted", scope: "model" }, detail);
  p.failed(a, "pro", { class: "exhausted", scope: "key" }, detail);
  now += 61_000; // both expired: the key is on probation
  p.succeeded(a, "pro");
  assert.deepEqual(p.snapshot()[0].keys[0].cooldowns.map((c) => c.model), ["flash"]);
});

test("unavailability reports the soonest return, and whether every key was rejected", () => {
  const p = pools("a1,b2");
  const [a, b] = p.candidates("deepseek", "m");
  p.failed(a, "m", { class: "invalid", scope: "key" }, detail);
  assert.equal(p.unavailability("deepseek", "m").onlyInvalid, false, "b2 is healthy");
  p.failed(b, "m", { class: "exhausted", scope: "key" }, detail);
  assert.deepEqual(p.unavailability("deepseek", "m"), { retryAfterMs: 60_000, onlyInvalid: false });
});

test("reset clears one key or the whole provider", () => {
  const p = pools("a1,b2");
  const [a, b] = p.candidates("deepseek", "m");
  p.failed(a, "m", { class: "exhausted", scope: "key" }, detail);
  p.failed(b, "m", { class: "exhausted", scope: "key" }, detail);
  assert.equal(p.reset("deepseek", a.id), 1);
  assert.deepEqual(secrets(p), ["a1"]);
  assert.equal(p.reset("deepseek"), 1);
  assert.equal(p.reset("nope"), null);
});
