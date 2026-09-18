import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { parseCatalog } from "../src/catalog.js";
import { KeyPools } from "../src/key-pool.js";
import { TokenCache } from "../src/auth.js";
import type { Config } from "../src/config.js";

// The example catalog is the fixture on purpose: `max` fails over from the mx5
// relay to DeepSeek, `default` and `pro` are single DeepSeek routes — the shapes
// the error handling has to get right.
const CATALOG_YAML = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);
const ONE_KEY_EACH = { DEEPSEEK_API_KEY: "sk-ds-aaaa", OPENAI_API_KEY: "sk-mx-1111" } as NodeJS.ProcessEnv;
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

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error;

const respond = (r: Reply) => {
  if (r instanceof Error) throw r;
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json", ...r.headers },
  });
};
const keyOf = (init: RequestInit) =>
  (init.headers as Record<string, string>).Authorization.replace("Bearer ", "");

/**
 * An upstream that answers each call with the next reply, and records which
 * model and which key each call carried.
 */
function upstream(...replies: Reply[]) {
  const calls: { model: string; key: string }[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({ model: JSON.parse(String(init.body)).model, key: keyOf(init) });
    const r = replies[calls.length - 1];
    if (!r) throw new Error(`unexpected upstream call #${calls.length}`);
    return respond(r);
  }) as unknown as typeof fetch;
  return { impl, calls, keys: () => calls.map((c) => c.key), models: () => calls.map((c) => c.model) };
}

/** Same, for several requests against one app: replies are queued between them. */
function queue() {
  const replies: Reply[] = [];
  const keys: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    keys.push(keyOf(init));
    const r = replies.shift();
    if (!r) throw new Error("unexpected upstream call");
    return respond(r);
  }) as unknown as typeof fetch;
  return {
    impl,
    push: (...r: Reply[]) => { replies.push(...r); },
    /** Keys used since the last `take()`. */
    take: () => keys.splice(0),
  };
}

function build(fetchImpl: typeof fetch, env = ONE_KEY_EACH, clock?: () => number) {
  const sql = fakeSql();
  const catalog = parseCatalog(CATALOG_YAML, env);
  const pools = clock ? new KeyPools(catalog, env, clock) : undefined;
  return { app: createApp({ cfg, catalog, sql, tokens, env, fetchImpl, pools }), sql };
}

const chat = (app: any, model: string) =>
  app.fetch(new Request(`http://gw/v1/teams/${TEAM}/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer token-44444444-4444-4444-8444-444444444444", "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  }));

const internal = (app: any, path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://gw/internal${path}`, {
    ...init,
    headers: { Authorization: "Bearer svc", "Content-Type": "application/json", ...(init.headers as object) },
  }));

const COMPLETION = {
  id: "c1", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const OK: Reply = { status: 200, body: COMPLETION };
// DeepSeek documents 402 as "Insufficient Balance: You have run out of balance".
const BROKE: Reply = { status: 402, body: { error: { message: "Insufficient Balance" } } };
const THROTTLED: Reply = { status: 429, body: { error: { message: "Rate limit reached for requests" } } };
const WEEKLY_LIMIT: Reply = {
  status: 429,
  body: { error: { message: "weekly usage limit reached. It will reset in 5 days 10 hours" } },
};

const TWO_DS_KEYS = { ...ONE_KEY_EACH, DEEPSEEK_API_KEY: "sk-ds-aaaa,sk-ds-bbbb" } as NodeJS.ProcessEnv;

// ── route failover (P0) ─────────────────────────────────────────────────────

for (const status of [402, 429, 500, 503]) {
  test(`max fails over to its backstop when the primary answers ${status}`, async (t) => {
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    const up = upstream({ status, body: { error: { message: "primary unavailable" } } }, OK);
    const { app, sql } = build(up.impl);

    const r = await chat(app, "max");
    assert.equal(r.status, 200);
    assert.deepEqual(up.models(), ["gpt-5.6-terra", "deepseek-v4-pro"]);
    assert.ok(sql.usageValues.includes("ds-v4-pro"), "usage is recorded against the backend that served");
  });
}

test("a dead primary is logged, or it is invisible behind the backstop", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const up = upstream({ status: 429, body: { error: { message: "usage_limit_reached" } } }, OK);
  await chat(build(up.impl).app, "max");
  assert.equal(errors.mock.callCount(), 1);
  assert.match(
    String(errors.mock.calls[0].arguments[0]),
    /mx5-gpt-5\.6-terra key …1111 .*429: exhausted .*usage_limit_reached/,
  );
});

for (const status of [400, 401, 403]) {
  test(`max does not fail over on ${status}; it passes through verbatim`, async (t) => {
    // 400 is the request's fault and would fail on every route; 401/403 is a
    // broken key, which should be loud rather than quietly served elsewhere.
    t.mock.method(console, "error", () => {});
    const body = { error: { message: `upstream said ${status}` } };
    const up = upstream({ status, body });
    const r = await chat(build(up.impl).app, "max");
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), body);
    assert.equal(up.calls.length, 1);
  });
}

test("a transport error fails over too", async (t) => {
  t.mock.method(console, "warn", () => {});
  const up = upstream(new Error("ECONNRESET"), OK);
  const r = await chat(build(up.impl).app, "max");
  assert.equal(r.status, 200);
  assert.equal(up.calls.length, 2);
});

test("an upstream 402 never reaches the caller as a 402", async (t) => {
  // 402 from this gateway means the TEAM is out of credits. The provider
  // account being out of balance is ours to fix, and must not tell a team with
  // credits to go top up.
  const errors = t.mock.method(console, "error", () => {});
  const r = await chat(build(upstream(BROKE).impl).app, "default");

  assert.equal(r.status, 503);
  const j = await r.json() as any;
  assert.equal(j.error.code, "upstream_billing_error");
  // pi retries any error mentioning 503 unless it also mentions billing.
  assert.match(j.error.message, /billing/);
  assert.equal(errors.mock.callCount(), 1, "the operator is the one who has to act");
  assert.match(String(errors.mock.calls[0].arguments[0]), /ds-v4-flash key …aaaa .*402: exhausted .*Insufficient Balance/);
});

test("when every failover route is out of balance the caller still gets 503, not 402", async (t) => {
  t.mock.method(console, "error", () => {});
  const up = upstream(BROKE, BROKE);
  const r = await chat(build(up.impl).app, "max");
  assert.equal(r.status, 503);
  assert.equal((await r.json() as any).error.code, "upstream_billing_error");
  assert.equal(up.calls.length, 2);
});

test("an upstream 429 on a single-route tier still passes through verbatim", async (t) => {
  t.mock.method(console, "warn", () => {});
  const r = await chat(build(upstream(THROTTLED).impl).app, "default");
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), (THROTTLED as any).body);
});

// ── key pools (P1) ──────────────────────────────────────────────────────────

test("a key out of balance hands the request to the next key of the same provider", async (t) => {
  t.mock.method(console, "error", () => {});
  const up = upstream(BROKE, OK);
  const { app, sql } = build(up.impl, TWO_DS_KEYS);

  const r = await chat(app, "default");
  assert.equal(r.status, 200, "the caller never sees the dead key");
  assert.deepEqual(up.keys(), ["sk-ds-aaaa", "sk-ds-bbbb"]);
  assert.deepEqual(up.models(), ["deepseek-v4-flash", "deepseek-v4-flash"], "same model, not a failover");
  assert.ok(sql.usageValues.includes("ds-v4-flash"));
});

test("a benched key is skipped by the requests after it", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);

  q.push(BROKE, OK);
  await chat(app, "default");
  q.take();

  q.push(OK);
  assert.equal((await chat(app, "default")).status, 200);
  assert.deepEqual(q.take(), ["sk-ds-bbbb"], "no second trip to the empty account");
});

test("a 402 benches the whole key, across every model on it", async (t) => {
  // Balance belongs to the account: an empty DeepSeek account cannot serve pro
  // any more than it could serve flash.
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);

  q.push(BROKE, OK);
  await chat(app, "default");
  q.take();

  q.push(OK);
  await chat(app, "pro");
  assert.deepEqual(q.take(), ["sk-ds-bbbb"]);
});

test("a 429 quota benches the key for that model only", async (t) => {
  // Subscription quotas are metered per model (OpenCode Go, Codex): a key at
  // its limit on one model may have plenty left on another.
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);

  q.push(WEEKLY_LIMIT, OK);
  await chat(app, "default");
  q.take();

  q.push(OK);
  await chat(app, "pro");
  assert.deepEqual(q.take(), ["sk-ds-aaaa"], "pro on the first key is untouched");

  q.push(OK);
  await chat(app, "default");
  assert.deepEqual(q.take(), ["sk-ds-bbbb"], "flash on the first key is still benched");
});

test("a throttled key is still tried when there is nothing else", async (t) => {
  // With a pool of one, refusing outright would turn one 429 into a blackout of
  // the whole tier for everyone.
  t.mock.method(console, "warn", () => {});
  const q = queue();
  const { app } = build(q.impl);

  q.push(THROTTLED);
  assert.equal((await chat(app, "default")).status, 429);
  q.take();

  q.push(OK);
  assert.equal((await chat(app, "default")).status, 200);
  assert.deepEqual(q.take(), ["sk-ds-aaaa"]);
});

test("with every key benched the caller is refused without an upstream call", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl);

  q.push(BROKE);
  await chat(app, "default");
  q.take();

  const r = await chat(app, "default");
  assert.equal(r.status, 503);
  assert.deepEqual(q.take(), [], "the empty account is not asked again inside its cooldown");
  const j = await r.json() as any;
  assert.equal(j.error.code, "upstream_keys_unavailable");
  // pi retries a 503 unless it also mentions quota exceeded.
  assert.match(j.error.message, /quota exceeded/);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
});

test("a benched primary sends max straight to the backstop", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl);

  q.push(WEEKLY_LIMIT, OK);
  await chat(app, "max");
  q.take();

  q.push(OK);
  assert.equal((await chat(app, "max")).status, 200);
  assert.deepEqual(q.take(), ["sk-ds-aaaa"], "no trip to the relay while it is benched");
});

test("a rejected key rotates within its pool", async (t) => {
  t.mock.method(console, "error", () => {});
  const up = upstream({ status: 401, body: { error: { message: "invalid api key" } } }, OK);
  const env = { ...ONE_KEY_EACH, OPENAI_API_KEY: "sk-mx-1111,sk-mx-2222" } as NodeJS.ProcessEnv;
  const r = await chat(build(up.impl, env).app, "max");
  assert.equal(r.status, 200);
  assert.deepEqual(up.keys(), ["sk-mx-1111", "sk-mx-2222"]);
  assert.deepEqual(up.models(), ["gpt-5.6-terra", "gpt-5.6-terra"], "served by the relay, not the backstop");
});

test("a pool whose every key was rejected does not fail over, even once benched", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl);

  q.push({ status: 401, body: { error: { message: "invalid api key" } } });
  assert.equal((await chat(app, "max")).status, 401);
  q.take();

  const r = await chat(app, "max");
  assert.equal(r.status, 503);
  assert.deepEqual(q.take(), [], "DeepSeek is not quietly serving a max tier with a broken key");
  assert.equal((await r.json() as any).error.code, "upstream_keys_unavailable");
});

test("a 5xx does not burn through the pool or bench the key", async (t) => {
  // Every key reaches the same broken service; trying them all only multiplies
  // the wait, and benching the key would outlive the outage.
  t.mock.method(console, "warn", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);

  q.push({ status: 500, body: { error: { message: "boom" } } });
  assert.equal((await chat(app, "default")).status, 500);
  assert.deepEqual(q.take(), ["sk-ds-aaaa"]);

  q.push(OK);
  await chat(app, "default");
  assert.deepEqual(q.take(), ["sk-ds-aaaa"]);
});

test("no more than three keys are tried on one route", async (t) => {
  t.mock.method(console, "error", () => {});
  const up = upstream(BROKE, BROKE, BROKE, OK);
  const env = { ...ONE_KEY_EACH, DEEPSEEK_API_KEY: "sk-1111,sk-2222,sk-3333,sk-4444" } as NodeJS.ProcessEnv;
  const r = await chat(build(up.impl, env).app, "default");
  assert.equal(r.status, 503);
  assert.equal(up.calls.length, 3);
});

test("a benched key comes back on its own once the cooldown runs out", async (t) => {
  t.mock.method(console, "error", () => {});
  let now = 1_000_000;
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS, () => now);

  q.push(BROKE, OK);
  await chat(app, "default");
  q.take();

  now += 61_000; // first strike is one minute
  q.push(OK);
  await chat(app, "default");
  assert.deepEqual(q.take(), ["sk-ds-aaaa"], "probed again, so a funded account rejoins without a restart");
});

// ── operator surface ────────────────────────────────────────────────────────

test("the pool snapshot needs the service token and never contains a key", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);
  q.push(BROKE, OK);
  await chat(app, "default");

  const denied = await app.fetch(new Request("http://gw/internal/provider-pools"));
  assert.equal(denied.status, 401);

  const r = await internal(app, "/provider-pools");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes("sk-ds-aaaa") && !text.includes("sk-ds-bbbb"), "secrets stay in the process");

  const ds = JSON.parse(text).providers.find((p: any) => p.providerId === "deepseek");
  assert.deepEqual(ds.keys.map((k: any) => k.hint), ["…aaaa", "…bbbb"]);
  const [first, second] = ds.keys;
  assert.equal(first.failed, 1);
  assert.equal(second.ok, 1);
  assert.equal(first.cooldowns.length, 1);
  assert.deepEqual(
    { model: first.cooldowns[0].model, class: first.cooldowns[0].class, active: first.cooldowns[0].active, status: first.cooldowns[0].status },
    { model: null, class: "exhausted", active: true, status: 402 },
  );
});

test("reset puts a benched key back into service immediately", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = queue();
  const { app } = build(q.impl, TWO_DS_KEYS);
  q.push(BROKE, OK);
  await chat(app, "default");
  q.take();

  const r = await internal(app, "/provider-pools/deepseek/reset", { method: "POST", body: "{}" });
  assert.deepEqual(await r.json(), { cleared: 1 });

  q.push(OK);
  await chat(app, "default");
  assert.deepEqual(q.take(), ["sk-ds-aaaa"]);

  const missing = await internal(app, "/provider-pools/nope/reset", { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);
});
