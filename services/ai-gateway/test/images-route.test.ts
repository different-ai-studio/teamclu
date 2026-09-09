import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { parseCatalog } from "../src/catalog.js";
import { TokenCache } from "../src/auth.js";
import type { Config } from "../src/config.js";

const ENV = { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
const catalog = parseCatalog(
  readFileSync(new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url), "utf8"),
  ENV,
);
const TEAM = "11111111-1111-4111-8111-111111111111";

/**
 * Enough of postgres.js to run the route: a tagged template that answers the
 * actor lookup and the usage insert, and records what it was asked.
 *
 * With enforcement off, reserve/settle/release never run, so this covers the
 * metering path without a database.
 */
function fakeSql() {
  const seen: string[] = [];
  const sql: any = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    seen.push(q.replace(/\s+/g, " ").trim());
    if (q.includes("ai_gateway_resolve_actor")) {
      return Promise.resolve([{ id: "22222222-2222-4222-8222-222222222222", actor_type: "member" }]);
    }
    if (q.includes("insert into amux.ai_usage_logs")) {
      (sql as any).usageValues = vals;
      return Promise.resolve([{ id: "33333333-3333-4333-8333-333333333333" }]);
    }
    return Promise.resolve([]);
  };
  sql.seen = seen;
  return sql;
}

const cfg = {
  port: 0, databaseUrl: "", catalogPath: "", serviceToken: "svc",
  backendKind: "supabase", supabaseUrl: "", supabaseAnonKey: "", authBaseUrl: "",
  tokenCacheTtlMs: 60_000, creditsEnforced: false, imageTimeoutMs: 5_000,
} as Config;
const tokens = new TokenCache(60_000, async (t) => t.replace("token-", ""));

function build(fetchImpl: typeof fetch, sql = fakeSql()) {
  return { app: createApp({ cfg, catalog, sql, tokens, env: ENV, fetchImpl }), sql };
}
const post = (app: any, body: unknown) =>
  app.fetch(new Request(`http://gw/v1/teams/${TEAM}/images/generations`, {
    method: "POST",
    headers: { Authorization: "Bearer token-44444444-4444-4444-8444-444444444444", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

const okUpstream = (images = 1) =>
  (async () => new Response(JSON.stringify({
    created: 1, size: "1024x1024", output_format: "png",
    data: Array.from({ length: images }, (_, i) => ({ b64_json: `img${i}`, revised_prompt: "r" })),
    usage: { input_tokens: 59, output_tokens: 515, total_tokens: 574 },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

test("generates an image and passes the upstream body through untouched", async () => {
  const { app, sql } = build(okUpstream());
  const r = await post(app, { model: "image", prompt: "a red leaf" });
  assert.equal(r.status, 200);
  const j = await r.json() as any;
  assert.equal(j.data[0].b64_json, "img0", "the caller stays a plain OpenAI client");

  // credits = delivered × unit; tokens are recorded but do NOT set the price.
  const v = (sql as any).usageValues;
  assert.ok(v.includes(300_000), `credits should be one image at 300000, got ${v}`);
  assert.ok(v.includes("fixed"), "usage_source must be 'fixed', not the estimated alarm value");
  assert.ok(v.includes(59) && v.includes(515), "image tokens are still recorded for margin");
});

test("bills what was delivered, not what was asked for", async () => {
  // Moderation dropping one of n is the normal partial case, and settling on
  // the request count would charge for a picture nobody got.
  const { app, sql } = build(okUpstream(2));
  await post(app, { model: "image", prompt: "x", n: 4 });
  assert.ok((sql as any).usageValues.includes(600_000), "2 delivered × 300000");
});

test("an unknown image model is 403, never a silent fallback", async () => {
  const { app } = build(okUpstream());
  const r = await post(app, { model: "dall-e-9", prompt: "x" });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as any).error.code, "model_not_allowed");
});

test("an unpriced size is refused before the upstream is ever called", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const { app } = build(spy);
  const r = await post(app, { model: "image", prompt: "x", size: "4096x4096" });
  assert.equal(r.status, 400);
  assert.equal((await r.json() as any).error.code, "unpriced_image_variant");
  assert.equal(called, false, "we must not pay for an image we cannot price");
});

test("an upstream error passes through verbatim and charges nothing", async () => {
  const body = JSON.stringify({ error: { code: "moderation_blocked", message: "no" } });
  const { app, sql } = build((async () =>
    new Response(body, { status: 400, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch);
  const r = await post(app, { model: "image", prompt: "x" });
  assert.equal(r.status, 400);
  assert.equal(await r.text(), body, "agent runtimes branch on the provider's own errors");
  assert.equal((sql as any).usageValues, undefined, "no usage row for an image never produced");
});

test("a 200 with no images charges zero", async () => {
  const { app, sql } = build((async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch);
  const r = await post(app, { model: "image", prompt: "x" });
  assert.equal(r.status, 200);
  assert.ok((sql as any).usageValues.includes(0), "zero delivered is zero charged");
});

test("the caller's team is proven against the actor table, not trusted", async () => {
  const { app, sql } = build(okUpstream());
  await post(app, { model: "image", prompt: "x" });
  assert.ok(
    (sql as any).seen.some((q: string) => q.includes("ai_gateway_resolve_actor")),
    ":teamId is caller-supplied; membership has to be looked up",
  );
});
