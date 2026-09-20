import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { parseCatalog } from "../src/catalog.js";
import { computeCredits, estimateTokens } from "../src/proxy.js";
import { TokenCache } from "../src/auth.js";
import type { Config } from "../src/config.js";

// Every way a chat request can end has to be metered AND settled. The hole this
// file guards: billing hung off a TransformStream flush(), which only runs on a
// clean close, so a client that hung up mid-stream — deliberately, one chunk
// before the usage frame, or just by pressing stop — left nothing but a hold
// that expired ten minutes later. Free tokens, and invisible to the member's
// quota, which is summed from the usage rows that were never written.

const ENV = { DEEPSEEK_API_KEY: "sk-ds-aaaa", OPENAI_API_KEY: "sk-mx-1111" } as NodeJS.ProcessEnv;
const catalog = parseCatalog(
  readFileSync(new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url), "utf8"),
  ENV,
);
const PRICE = catalog.public_models.default.pricing;
const TEAM = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "55555555-5555-4555-8555-555555555555";

const cfg = {
  port: 0, databaseUrl: "", catalogPath: "", serviceToken: "svc",
  backendKind: "supabase", supabaseUrl: "", supabaseAnonKey: "", authBaseUrl: "",
  tokenCacheTtlMs: 60_000, creditsEnforced: true, imageTimeoutMs: 5_000,
} as Config;
const tokens = new TokenCache(60_000, async (t) => t.replace("token-", ""));

type UsageRow = {
  inputTokens: number; outputTokens: number; credits: number;
  usageSource: string; statusCode: number; stream: boolean;
};

/** Enough of the ledger to see what a request did to it, in order. No database. */
function ledgerSql() {
  const ops: string[] = [];
  const state: { usage: UsageRow | null; debited: number; held: number } = { usage: null, debited: 0, held: 0 };
  const sql: any = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("ai_gateway_resolve_actor")) {
      return Promise.resolve([{ id: "22222222-2222-4222-8222-222222222222", actor_type: "member" }]);
    }
    if (q.includes("select balance_credits")) return Promise.resolve([{ balance_credits: "999999999999" }]);
    if (q.includes("insert into amux.credit_reservation")) {
      ops.push("reserve");
      state.held = vals[2] as number;
      return Promise.resolve([{ id: HOLD_ID }]);
    }
    if (q.includes("insert into amux.ai_usage_logs")) {
      ops.push("usage");
      // Positional, in the column order of `recordUsage`.
      state.usage = {
        inputTokens: vals[5] as number, outputTokens: vals[7] as number, credits: vals[8] as number,
        usageSource: vals[9] as string, statusCode: vals[10] as number, stream: vals[11] as boolean,
      };
      return Promise.resolve([{ id: "33333333-3333-4333-8333-333333333333" }]);
    }
    if (q.includes("insert into amux.credit_ledger")) {
      ops.push("debit");
      state.debited = -(vals[2] as number);
      return Promise.resolve([]);
    }
    if (q.includes("set state = 'settled'")) { ops.push("settle"); return Promise.resolve([]); }
    if (q.includes("set state = 'expired'")) { ops.push("release"); return Promise.resolve([]); }
    return Promise.resolve([]);
  };
  sql.begin = (fn: (tx: unknown) => unknown) => fn(sql);
  return { sql, ops, state };
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const content = (text: string) => frame({ choices: [{ index: 0, delta: { content: text } }] });
const FINAL = frame({
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 5000, completion_tokens: 40 },
});
const DONE = "data: [DONE]\n\n";

/**
 * An upstream SSE body that hands out one frame per pull, `gapMs` apart, so a
 * test can hang up between two of them. `die` fails the body instead of ending
 * it, the way a reset connection does.
 */
function streamingUpstream(frames: string[], opts: { gapMs?: number; die?: boolean } = {}) {
  const seen = { cancelled: false, aborted: false, sent: 0 };
  const impl = (async (_url: string, init: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
        // What fetch does to a body when its signal fires.
        if (init.signal?.aborted) {
          seen.aborted = true;
          ctrl.error(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        if (seen.sent < frames.length) ctrl.enqueue(enc.encode(frames[seen.sent++]));
        else if (opts.die) ctrl.error(new Error("ECONNRESET"));
        else ctrl.close();
      },
      cancel() { seen.cancelled = true; },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const MESSAGES = [{ role: "user", content: "hi" }];
const EST_INPUT = estimateTokens(Buffer.byteLength(JSON.stringify(MESSAGES)));
const requestBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "default", stream: true, messages: MESSAGES, ...extra });
const HEADERS = {
  Authorization: "Bearer token-44444444-4444-4444-8444-444444444444",
  "Content-Type": "application/json",
};

function build(fetchImpl: typeof fetch) {
  const db = ledgerSql();
  return { ...db, app: createApp({ cfg, catalog, sql: db.sql, tokens, env: ENV, fetchImpl }) };
}
const chat = (app: any, extra?: Record<string, unknown>) =>
  app.fetch(new Request(`http://gw/v1/teams/${TEAM}/chat/completions`, {
    method: "POST", headers: HEADERS, body: requestBody(extra),
  }));

/** Settlement is fire-and-forget off the stream's end; give it a turn to land. */
async function settled(ops: string[]) {
  for (let i = 0; i < 100 && !ops.includes("settle") && !ops.includes("release"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a stream read to the end is charged the upstream's own count", async () => {
  const up = streamingUpstream([content("hello"), FINAL, DONE]);
  const { app, ops, state } = build(up.impl);
  await (await chat(app)).text();
  await settled(ops);

  assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
  assert.equal(state.usage!.usageSource, "upstream");
  assert.equal(state.usage!.statusCode, 200);
  assert.equal(state.usage!.credits, computeCredits(PRICE, 5000, 40));
});

test("a client that hangs up mid-stream is still metered and charged", async () => {
  const up = streamingUpstream([content("x".repeat(300)), content("never read"), FINAL, DONE], { gapMs: 5 });
  const { app, ops, state } = build(up.impl);

  const reader = (await chat(app)).body!.getReader();
  await reader.read();
  await reader.cancel();
  await settled(ops);

  // Before the fix this was ["reserve"]: no row, no debit, and a hold left to expire.
  assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
  assert.equal(state.usage!.usageSource, "estimated");
  assert.equal(state.usage!.statusCode, 499);
  assert.equal(state.usage!.stream, true);
  assert.equal(state.usage!.inputTokens, EST_INPUT);
  assert.ok(state.usage!.outputTokens >= estimateTokens(300), "what streamed before the hang-up is billed");
  assert.equal(state.usage!.credits, computeCredits(PRICE, EST_INPUT, state.usage!.outputTokens));
  assert.equal(state.debited, state.usage!.credits, "the ledger debit matches the usage row");
  assert.ok(up.seen.cancelled, "and the upstream is told to stop generating");
});

test("a dropped connection on the real server is metered and charged", async () => {
  // The same thing over a socket, because that is where it happens: here the
  // abort arrives through @hono/node-server rather than a tidy body.cancel().
  const up = streamingUpstream(
    [...Array.from({ length: 40 }, () => content("x".repeat(30))), FINAL, DONE],
    { gapMs: 10 },
  );
  const { app, ops, state } = build(up.impl);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: `/v1/teams/${TEAM}/chat/completions`, method: "POST", headers: HEADERS },
        (res) => {
          let chunks = 0;
          res.on("data", () => { if (++chunks === 3) { req.destroy(); resolve(); } });
          res.on("error", () => {});
        },
      );
      req.on("error", (e) => { if (!req.destroyed) reject(e); });
      req.end(requestBody());
    });
    await settled(ops);

    assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
    assert.equal(state.usage!.usageSource, "estimated");
    assert.equal(state.usage!.statusCode, 499, "a client abort, not an upstream failure");
    assert.ok(state.usage!.credits > computeCredits(PRICE, EST_INPUT, 0), "output is charged, not just the prompt");
    assert.ok(up.seen.sent < 40, "the upstream stopped early instead of generating for nobody");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("hanging up after the usage frame is charged exactly, not estimated", async () => {
  // DeepSeek rides usage on the last content chunk, ahead of [DONE]. Once it
  // has gone past, the upstream's number is the bill.
  const up = streamingUpstream([content("hello"), FINAL, DONE], { gapMs: 5 });
  const { app, ops, state } = build(up.impl);

  const reader = (await chat(app)).body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  await settled(ops);

  assert.equal(state.usage!.usageSource, "upstream");
  assert.equal(state.usage!.statusCode, 499);
  assert.equal(state.usage!.credits, computeCredits(PRICE, 5000, 40));
});

test("an upstream that dies mid-stream is charged for what it produced", async () => {
  const up = streamingUpstream([content("x".repeat(90))], { die: true });
  const { app, ops, state } = build(up.impl);
  await (await chat(app)).text().catch(() => {});
  await settled(ops);

  assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
  assert.equal(state.usage!.usageSource, "estimated");
  assert.equal(state.usage!.statusCode, 502, "distinct from a client abort: this one is the upstream's doing");
  assert.equal(state.usage!.credits, computeCredits(PRICE, EST_INPUT, estimateTokens(90)));
});

test("a stream that completes without a usage frame is charged, not logged at zero", async () => {
  // `estimated` with a 200 is the alarm: an upstream stopped reporting usage.
  // It used to be recorded — and billed — as 0 credits.
  const up = streamingUpstream([content("x".repeat(90)), DONE]);
  const { app, ops, state } = build(up.impl);
  await (await chat(app)).text();
  await settled(ops);

  assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
  assert.equal(state.usage!.usageSource, "estimated");
  assert.equal(state.usage!.statusCode, 200);
  assert.equal(state.usage!.credits, computeCredits(PRICE, EST_INPUT, estimateTokens(90)));
});

test("an estimate never charges past the hold", async () => {
  const up = streamingUpstream([content("x".repeat(30_000)), DONE]);
  const { app, ops, state } = build(up.impl);
  await (await chat(app, { max_tokens: 10 })).text();
  await settled(ops);

  assert.equal(state.usage!.outputTokens, estimateTokens(30_000), "the row records what was seen");
  assert.equal(state.usage!.credits, computeCredits(PRICE, EST_INPUT, 10), "the charge stops at what was reserved");
});

test("a non-streamed reply without usage is estimated from the message", async () => {
  const impl = (async () => new Response(
    JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "x".repeat(90) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
  const { app, ops, state } = build(impl);
  await (await chat(app, { stream: false })).json();
  await settled(ops);

  assert.deepEqual(ops, ["reserve", "usage", "debit", "settle"]);
  assert.equal(state.usage!.usageSource, "estimated");
  assert.equal(state.usage!.credits, computeCredits(PRICE, EST_INPUT, estimateTokens(90)));
});

// ── sizing the hold ─────────────────────────────────────────────────────────

test("a Chinese prompt is sized by its bytes, not its UTF-16 length", async () => {
  // `.length` counts a CJK character as one unit, the same as an ASCII letter,
  // though it is three bytes and most of a token upstream. Sized that way a
  // Chinese prompt reserved about half of what it went on to cost — and since
  // an interrupted request is charged this same input estimate, it was a
  // discount too, on a Chinese-first product.
  const messages = [{ role: "user", content: "请帮我总结这份文档。".repeat(200) }];
  const json = JSON.stringify(messages);
  const byBytes = estimateTokens(Buffer.byteLength(json));
  const byUnits = Math.ceil(json.length / 3);
  assert.ok(byBytes > byUnits * 2.5, "the two readings differ by ~3x on CJK text, so this test can tell them apart");

  const up = streamingUpstream([content("好"), content("never read"), FINAL, DONE], { gapMs: 5 });
  const { app, ops, state } = build(up.impl);
  const reader = (await chat(app, { messages, max_tokens: 100 })).body!.getReader();
  await reader.read();
  await reader.cancel();
  await settled(ops);

  assert.equal(state.held, computeCredits(PRICE, byBytes, 100), "the hold");
  assert.equal(state.usage!.inputTokens, byBytes, "and the input an interrupted request is charged for");
});

test("an ASCII prompt is sized exactly as before", async () => {
  // Bytes and UTF-16 units agree on ASCII, so English traffic — and every
  // hold it produces — is untouched by the switch to bytes.
  const messages = [{ role: "user", content: "summarise this document. ".repeat(200) }];
  const json = JSON.stringify(messages);
  assert.equal(Buffer.byteLength(json), json.length);

  const up = streamingUpstream([content("ok"), FINAL, DONE]);
  const { app, ops, state } = build(up.impl);
  await (await chat(app, { messages, max_tokens: 100 })).text();
  await settled(ops);

  assert.equal(state.held, computeCredits(PRICE, Math.ceil(json.length / 3), 100));
});
