import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { parseCatalog } from "../src/catalog.js";
import { TokenCache } from "../src/auth.js";
import type { Config } from "../src/config.js";

// The example catalog is the fixture on purpose: `max` fails over from the mx5
// relay to DeepSeek, `default` is a single DeepSeek route — the two shapes the
// error handling has to get right.
const ENV = { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
const catalog = parseCatalog(
  readFileSync(new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url), "utf8"),
  ENV,
);
const TEAM = "11111111-1111-4111-8111-111111111111";

/** Same stand-in as images-route.test.ts: actor lookup + usage insert, no database. */
function fakeSql() {
  const sql: any = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("ai_gateway_resolve_actor")) {
      return Promise.resolve([{ id: "22222222-2222-4222-8222-222222222222", actor_type: "member" }]);
    }
    if (q.includes("insert into amux.ai_usage_logs")) {
      sql.usageValues = vals;
      return Promise.resolve([{ id: "33333333-3333-4333-8333-333333333333" }]);
    }
    return Promise.resolve([]);
  };
  return sql;
}

const cfg = {
  port: 0, databaseUrl: "", catalogPath: "", serviceToken: "svc",
  backendKind: "supabase", supabaseUrl: "", supabaseAnonKey: "", authBaseUrl: "",
  tokenCacheTtlMs: 60_000, creditsEnforced: false, imageTimeoutMs: 5_000,
} as Config;
const tokens = new TokenCache(60_000, async (t) => t.replace("token-", ""));

type Reply = { status: number; body: unknown } | Error;

/** An upstream that answers each call with the next reply, and records which model it was asked for. */
function upstream(...replies: Reply[]) {
  const models: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    const r = replies[models.length - 1];
    if (!r) throw new Error(`unexpected upstream call #${models.length}`);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, models };
}

function build(fetchImpl: typeof fetch) {
  const sql = fakeSql();
  return { app: createApp({ cfg, catalog, sql, tokens, env: ENV, fetchImpl }), sql };
}

const chat = (app: any, model: string) =>
  app.fetch(new Request(`http://gw/v1/teams/${TEAM}/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer token-44444444-4444-4444-8444-444444444444", "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  }));

const COMPLETION = {
  id: "c1", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
// DeepSeek documents 402 as "Insufficient Balance: You have run out of balance".
const OUT_OF_BALANCE = { error: { message: "Insufficient Balance" } };

for (const status of [402, 429, 500, 503]) {
  test(`max fails over to its backstop when the primary answers ${status}`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const up = upstream({ status, body: { error: { message: "primary unavailable" } } }, { status: 200, body: COMPLETION });
    const { app, sql } = build(up.impl);

    const r = await chat(app, "max");
    assert.equal(r.status, 200);
    assert.deepEqual(up.models, ["gpt-5.6-terra", "deepseek-v4-pro"]);
    assert.ok(sql.usageValues.includes("ds-v4-pro"), "usage is recorded against the backend that served");
  });
}

test("a failover hop is logged, or a dead primary is invisible behind the backstop", async (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const up = upstream({ status: 429, body: { error: { message: "usage_limit_reached" } } }, { status: 200, body: COMPLETION });
  await chat(build(up.impl).app, "max");
  assert.equal(warned.mock.callCount(), 1);
  assert.match(String(warned.mock.calls[0].arguments[0]), /mx5-gpt-5\.6-terra.*429.*usage_limit_reached/);
});

for (const status of [400, 401, 403]) {
  test(`max does not fail over on ${status}; it passes through verbatim`, async () => {
    // 400 is the request's fault and would fail on every route; 401/403 is a
    // broken key, which should be loud rather than quietly served elsewhere.
    const body = { error: { message: `upstream said ${status}` } };
    const up = upstream({ status, body });
    const r = await chat(build(up.impl).app, "max");
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), body);
    assert.equal(up.models.length, 1);
  });
}

test("a transport error fails over too", async () => {
  const up = upstream(new Error("ECONNRESET"), { status: 200, body: COMPLETION });
  const r = await chat(build(up.impl).app, "max");
  assert.equal(r.status, 200);
  assert.equal(up.models.length, 2);
});

test("an upstream 402 never reaches the caller as a 402", async (t) => {
  // 402 from this gateway means the TEAM is out of credits. The provider
  // account being out of balance is ours to fix, and must not tell a team with
  // credits to go top up.
  const logged = t.mock.method(console, "error", () => {});
  const up = upstream({ status: 402, body: OUT_OF_BALANCE });
  const r = await chat(build(up.impl).app, "default");

  assert.equal(r.status, 503);
  const j = await r.json() as any;
  assert.equal(j.error.code, "upstream_billing_error");
  // pi retries any error mentioning 503 unless it also mentions billing.
  assert.match(j.error.message, /billing/);
  assert.equal(logged.mock.callCount(), 1, "the operator is the one who has to act");
  assert.match(String(logged.mock.calls[0].arguments[0]), /ds-v4-flash.*out of balance.*Insufficient Balance/);
});

test("when every failover route is out of balance the caller still gets 503, not 402", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const up = upstream({ status: 402, body: OUT_OF_BALANCE }, { status: 402, body: OUT_OF_BALANCE });
  const r = await chat(build(up.impl).app, "max");
  assert.equal(r.status, 503);
  assert.equal((await r.json() as any).error.code, "upstream_billing_error");
  assert.equal(up.models.length, 2);
});

test("an upstream 429 on a single-route tier still passes through verbatim", async () => {
  const body = { error: { message: "Rate limit reached" } };
  const up = upstream({ status: 429, body });
  const r = await chat(build(up.impl).app, "default");
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), body);
});
