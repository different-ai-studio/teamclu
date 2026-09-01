import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCredits, filterBody, readUsage, teeSseUsage } from "../src/proxy.js";

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
    { dropUsageOnlyFrame: false, onUsage: (u) => { seen = u; } },
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
    { dropUsageOnlyFrame: true, onUsage: () => {} },
  ));
  assert.ok(out.includes('"content":"hi"'));
  assert.ok(!out.includes('"usage"'), "usage-only frame should be dropped");
  assert.ok(out.includes("[DONE]"));
});

test("keeps a usage frame that also carries content (DeepSeek's shape)", async () => {
  // DeepSeek rides usage on the last NORMAL chunk; dropping it would eat output.
  const out = await drain(teeSseUsage(
    sse('{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}'),
    { dropUsageOnlyFrame: true, onUsage: () => {} },
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
    { dropUsageOnlyFrame: false, onUsage: (u) => { seen = u; } },
  ));
  assert.equal(seen?.inputTokens, 7);
});
