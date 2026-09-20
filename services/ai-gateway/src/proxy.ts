import type { Catalog, ImagePricing, Pricing, Provider, BackendModel } from "./catalog.js";

export type UpstreamUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/**
 * Charge input and output at the TIER's price (design §4.4). Which backend the
 * request actually landed on does not change the amount — that variance is
 * margin, not the customer's problem.
 *
 * ceil() per direction is why the unit has to be fine (§4.4.1): at a coarse
 * unit a 5k-token request rounds up by multiples, and agent traffic is all
 * small requests.
 */
export function computeCredits(p: Pricing, inputTokens: number, outputTokens: number): number {
  return (
    Math.ceil((inputTokens * p.input_per_1m_credits) / 1_000_000) +
    Math.ceil((outputTokens * p.output_per_1m_credits) / 1_000_000)
  );
}

/**
 * Drop body keys the upstream does not know about. Replaces LiteLLM's
 * `drop_params: true`: agent runtimes send a superset of the OpenAI params.
 * DeepSeek was measured to tolerate unknown keys, so this is defensive — it
 * earns its keep the day a stricter provider is added.
 */
export function filterBody(body: Record<string, unknown>, supported: string[]): Record<string, unknown> {
  const allow = new Set(supported);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (allow.has(k)) out[k] = v;
  return out;
}

/** Pull usage out of a parsed chunk / response body, normalising DeepSeek's cache fields. */
export function readUsage(obj: any): UpstreamUsage | null {
  const u = obj?.usage;
  if (!u || typeof u !== "object") return null;
  const input = Number(u.prompt_tokens ?? 0);
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    inputTokens: input,
    cachedInputTokens: Number.isFinite(cached) ? cached : 0,
    outputTokens: Number(u.completion_tokens ?? 0),
  };
}

export type PreparedRequest = {
  url: string;
  init: RequestInit;
  /** True when the gateway added stream_options itself and must hide the effect. */
  injectedUsageOption: boolean;
};

export function prepareUpstream(
  cat: Catalog,
  provider: Provider,
  backendId: string,
  backend: BackendModel,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): PreparedRequest {
  const supported = backend.supported_params ?? cat.default_supported_params;
  const out = filterBody(body, supported);
  out.model = backend.upstream_model;

  // Providers differ in how streaming usage is reported (§4.4.0.1):
  //   always               — DeepSeek returns it on the last normal chunk.
  //   needs_stream_options — OpenAI needs the flag and then emits an EXTRA
  //                          usage-only frame, which we hide from a client
  //                          that never asked for it.
  let injected = false;
  if (out.stream === true && provider.usage_mode === "needs_stream_options") {
    const existing = out.stream_options as Record<string, unknown> | undefined;
    if (!existing?.include_usage) {
      out.stream_options = { ...(existing ?? {}), include_usage: true };
      injected = true;
    }
  }

  return {
    url: `${provider.api_base.replace(/\/+$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(out),
      signal,
    },
    injectedUsageOption: injected,
  };
}

/**
 * Tokens to bill for text the upstream never counted for us. Bytes rather than
 * characters, and a divisor of 3, so it errs high for both scripts: English
 * runs ~4 bytes per token, and a CJK character is 3 bytes for well under one
 * token. An estimate that errs low is a discount for hanging up.
 */
export function estimateTokens(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / 3);
}

/**
 * UTF-8 bytes of everything a chunk — or a whole non-streamed response —
 * generated. Reasoning and tool-call arguments count: the upstream bills them
 * as completion tokens like any other output.
 */
export function generatedBytes(obj: any): number {
  let n = 0;
  for (const choice of Array.isArray(obj?.choices) ? obj.choices : []) {
    const m = choice?.delta ?? choice?.message;
    if (!m || typeof m !== "object") continue;
    for (const k of ["content", "reasoning_content", "reasoning", "refusal"]) {
      if (typeof m[k] === "string") n += Buffer.byteLength(m[k]);
    }
    for (const t of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (typeof t?.function?.name === "string") n += Buffer.byteLength(t.function.name);
      if (typeof t?.function?.arguments === "string") n += Buffer.byteLength(t.function.arguments);
    }
  }
  return n;
}

export type StreamEnd = {
  /**
   * complete  — the upstream finished.
   * cancelled — the consumer hung up first.
   * errored   — the upstream body failed mid-stream: a reset, or the fetch
   *             aborted along with the client's own request.
   */
  outcome: "complete" | "cancelled" | "errored";
  /** `generatedBytes` summed over every frame that went past. */
  generatedBytes: number;
};

type TeeOpts = {
  dropUsageOnlyFrame: boolean;
  onUsage: (u: UpstreamUsage) => void;
  /**
   * Called exactly once, however the stream ends. Required on purpose: billing
   * hangs off it, and a stream whose end can be ignored is a stream that can be
   * cut short for free.
   */
  onEnd: (end: StreamEnd) => void;
};

/**
 * Pipe an upstream SSE body straight through while tee-ing the usage frame out
 * of it. Chunk-by-chunk: buffering the whole response first would destroy the
 * streaming experience that the agent runtime depends on.
 */
export function teeSseUsage(
  upstream: ReadableStream<Uint8Array>,
  opts: TeeOpts,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const tally = { generatedBytes: 0 };
  let buf = "";

  // Taken here rather than inside start() so cancel() can reach it: the stream
  // is locked from this point on, and cancelling a locked stream directly only
  // rejects.
  const reader = upstream.getReader();

  let ended = false;
  const end = (outcome: StreamEnd["outcome"]) => {
    if (ended) return;
    ended = true;
    opts.onEnd({ outcome, generatedBytes: tally.generatedBytes });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || ended) break;
          buf += decoder.decode(value, { stream: true });

          // Keep the trailing partial event in the buffer; SSE events are
          // separated by a blank line and a chunk can split one anywhere.
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, idx + 2);
            buf = buf.slice(idx + 2);
            controller.enqueue(encoder.encode(handleEvent(rawEvent, opts, tally)));
          }
        }
        // Cancelled mid-read: the controller is already closed, and cancel()
        // has reported the end.
        if (ended) return;
        if (buf) controller.enqueue(encoder.encode(handleEvent(buf, opts, tally)));
        controller.close();
        end("complete");
      } catch (err) {
        if (ended) return;
        end("errored");
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      // Already drained: the upstream is finished and the lock released.
      if (ended) return;
      end("cancelled");
      // Client hung up -> propagate upstream so we stop paying for tokens
      // nobody will read.
      return reader.cancel(reason);
    },
  });
}

function handleEvent(
  rawEvent: string,
  opts: TeeOpts,
  tally: { generatedBytes: number },
): string {
  const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return rawEvent;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return rawEvent;
  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return rawEvent;
  }
  const usage = readUsage(obj);
  if (usage) opts.onUsage(usage);
  tally.generatedBytes += generatedBytes(obj);

  // A usage-only frame (no choices) exists solely because we asked for it.
  // Passing it to a client that never set stream_options would be a frame it
  // does not expect.
  const isUsageOnly = usage != null && Array.isArray(obj.choices) && obj.choices.length === 0;
  if (isUsageOnly && opts.dropUsageOnlyFrame) return "";
  return rawEvent;
}


// ── images ──────────────────────────────────────────────────────────────────

/**
 * What one image costs, most-specific key first.
 *
 * A request that NAMES a size we have not priced is refused (`null`) rather
 * than charged the `default`. `default` exists for a request that asks for no
 * particular size — a size we do not recognise is most likely a new, expensive
 * tier the upstream just shipped, and quietly serving it at the cheapest price
 * we have is how a catalogue gap turns into free images.
 */
export function pricePerImage(
  p: ImagePricing,
  size?: string,
  quality?: string,
): number | null {
  const per = p.per_image_credits;
  if (size) {
    if (quality && Number.isFinite(per[`${size}:${quality}`])) return per[`${size}:${quality}`];
    if (Number.isFinite(per[size])) return per[size];
    return null;
  }
  return Number.isFinite(per.default) ? per.default : null;
}

/**
 * Usage off an images response.
 *
 * Separate from `readUsage` because the field names differ: images report
 * `input_tokens` / `output_tokens`, chat reports `prompt_tokens` /
 * `completion_tokens`. Feeding an image response to `readUsage` silently
 * returns zeros, which would look like a working meter recording nothing.
 * Measured against the live endpoint 2026-09-09.
 *
 * These numbers are recorded for margin analysis only — images are billed per
 * image (see `ImagePricing`).
 */
export function readImageUsage(obj: any): UpstreamUsage | null {
  const u = obj?.usage;
  if (!u || typeof u !== "object") return null;
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    cachedInputTokens: 0,
    outputTokens: Number.isFinite(output) ? output : 0,
  };
}

/** How many images actually came back. Bills the delivery, not the request. */
export function countImages(obj: any): number {
  return Array.isArray(obj?.data) ? obj.data.length : 0;
}

export function prepareImageUpstream(
  cat: Catalog,
  provider: Provider,
  backend: BackendModel,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): PreparedRequest {
  const out = filterBody(body, cat.default_image_params);
  out.model = backend.upstream_model;
  return {
    url: `${provider.api_base.replace(/\/+$/, "")}/images/generations`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(out),
      signal,
    },
    injectedUsageOption: false,
  };
}
