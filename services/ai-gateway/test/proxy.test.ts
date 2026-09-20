import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCredits, estimateTokens, filterBody, generatedBytes, readUsage, teeSseUsage,
  type StreamEnd,
} from "../src/proxy.js";

const PRICE = { input_per_1m_credits: 1_000_000, output_per_1m_credits: 4_000_000 };

test("credits charge input and output at the tier price", () => {
  // 1 credit per input token, 4 per output token at this tier.
  assert.equal(computeCredits(PRICE, 5_000, 0), 5_000);
  assert.equal(computeCredits(PRICE, 0, 1_000), 4_000);
  assert.equal(computeCredits(PRICE, 5_000, 1_000), 9_000);
});

test("the unit is fine enough that ceil() does not distort a small request", () => {
  // The failure this guards: at a coarse unit a 5k-token request rounds up by
  // multiples, and agent traffic is all small requests (design §4.4.1).
  const exact = (5_000 * PRICE.input_per_1m_credits) / 1_000_000;
  const charged = computeCredits(PRICE, 5_000, 0);
  assert.ok((charged - exact) / exact < 0.001, `rounding error too large: ${charged} vs ${exact}`);
});

test("unknown params are dropped", () => {
  const out = filterBody(
    { model: "x", messages: [], some_bogus_param: 1, temperature: 0.5 },
    ["model", "messages", "temperature"],
  );
  assert.deepEqual(out, { model: "x", messages: [], temperature: 0.5 });
});

test("reads DeepSeek's cache split out of usage", () => {
  const u = readUsage({
    usage: {
      prompt_tokens: 3476, completion_tokens: 8,
      prompt_cache_hit_tokens: 3456, prompt_cache_miss_tokens: 20,
    },
  });
  assert.deepEqual(u, { inputTokens: 3476, cachedInputTokens: 3456, outputTokens: 8 });
});

test("reads OpenAI's cached_tokens shape too", () => {
  const u = readUsage({
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
  });
  assert.equal(u!.cachedInputTokens, 64);
});

function sse(...events: string[]) {
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
  });
}
async function drain(s: ReadableStream<Uint8Array>) {
  let out = ""; const r = s.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; out += new TextDecoder().decode(value); }
  return out;
}

test("streams through chunk by chunk and tees the usage frame", async () => {
  let seen: any = null;
  const out = await drain(teeSseUsage(
    sse('{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        "[DONE]"),
    { dropUsageOnlyFrame: false, onUsage: (u) => { seen = u; }, onEnd: () => {} },
  ));
  assert.deepEqual(seen, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 });
  assert.ok(out.includes('"content":"hi"'));
  assert.ok(out.includes("[DONE]"));
});

test("swallows the usage-only frame the gateway asked for, keeps the rest", async () => {
  // OpenAI emits an extra choices:[] frame when include_usage is injected. A
  // client that never set stream_options must not receive it.
  const out = await drain(teeSseUsage(
    sse('{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        "[DONE]"),
    { dropUsageOnlyFrame: true, onUsage: () => {}, onEnd: () => {} },
  ));
  assert.ok(out.includes('"content":"hi"'));
  assert.ok(!out.includes('"usage"'), "usage-only frame should be dropped");
  assert.ok(out.includes("[DONE]"));
});

test("keeps a usage frame that also carries content (DeepSeek's shape)", async () => {
  // DeepSeek rides usage on the last NORMAL chunk; dropping it would eat output.
  const out = await drain(teeSseUsage(
    sse('{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}'),
    { dropUsageOnlyFrame: true, onUsage: () => {}, onEnd: () => {} },
  ));
  assert.ok(out.includes('"finish_reason":"stop"'), "must not drop a frame carrying choices");
});

test("reassembles events split across chunk boundaries", async () => {
  const parts = ['data: {"choices":[],"usa', 'ge":{"prompt_tokens":7,"completion_tokens":1}}\n\n'];
  let seen: any = null;
  await drain(teeSseUsage(
    new ReadableStream<Uint8Array>({
      start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
    }),
    { dropUsageOnlyFrame: false, onUsage: (u) => { seen = u; }, onEnd: () => {} },
  ));
  assert.equal(seen?.inputTokens, 7);
});

// ── how a stream ends ───────────────────────────────────────────────────────
// Billing hangs off `onEnd`, so "exactly once, whichever way it ends" is the
// property that matters. It used to hang off a flush(), which a hung-up client
// never reaches.

test("reports a clean end once, with what was generated", async () => {
  const ends: StreamEnd[] = [];
  await drain(teeSseUsage(
    sse('{"choices":[{"delta":{"content":"hello"}}]}', '{"choices":[{"delta":{"content":"!"}}]}', "[DONE]"),
    { dropUsageOnlyFrame: false, onUsage: () => {}, onEnd: (e) => ends.push(e) },
  ));
  assert.deepEqual(ends, [{ outcome: "complete", generatedBytes: 6 }]);
});

test("a consumer that hangs up ends the stream as cancelled, and stops the upstream", async () => {
  let upstreamCancelled = false;
  const enc = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"abc"}}]}\n\n')); },
    // The old cancel() called upstream.cancel() on a stream its own reader had
    // locked, which only rejects: the upstream kept generating.
    cancel() { upstreamCancelled = true; },
  }, { highWaterMark: 0 });

  const ends: StreamEnd[] = [];
  const reader = teeSseUsage(upstream, {
    dropUsageOnlyFrame: false, onUsage: () => {}, onEnd: (e) => ends.push(e),
  }).getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(ends.length, 1, "onEnd must fire exactly once");
  assert.equal(ends[0].outcome, "cancelled");
  assert.ok(ends[0].generatedBytes >= 3, "what streamed before the hang-up is what gets billed");
  assert.ok(upstreamCancelled, "the cancel has to reach the upstream body");
});

test("an upstream that dies mid-stream ends it as errored", async () => {
  const enc = new TextEncoder();
  let n = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n++ === 0) c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ab"}}]}\n\n'));
      else c.error(new Error("ECONNRESET"));
    },
  });
  const ends: StreamEnd[] = [];
  await assert.rejects(drain(teeSseUsage(upstream, {
    dropUsageOnlyFrame: false, onUsage: () => {}, onEnd: (e) => ends.push(e),
  })));
  assert.deepEqual(ends, [{ outcome: "errored", generatedBytes: 2 }]);
});

test("generated bytes count reasoning and tool calls, in UTF-8", () => {
  // The upstream bills all of these as completion tokens.
  assert.equal(generatedBytes({ choices: [{ delta: { content: "ab", reasoning_content: "cde" } }] }), 5);
  assert.equal(generatedBytes({
    choices: [{ delta: { tool_calls: [{ function: { name: "get", arguments: '{"a":1}' } }] } }],
  }), 3 + 7);
  // Non-streamed responses carry `message` instead of `delta`.
  assert.equal(generatedBytes({ choices: [{ message: { content: "abcd" } }] }), 4);
  // A CJK character is one UTF-16 unit but three bytes. Counting units would
  // price Chinese output at a third of English.
  assert.equal(generatedBytes({ choices: [{ delta: { content: "你好" } }] }), 6);
  assert.equal(generatedBytes({ choices: [], usage: {} }), 0);
  assert.equal(generatedBytes(null), 0);
});

test("the token estimate rounds up", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(6), 2);
  assert.equal(estimateTokens(7), 3);
});
