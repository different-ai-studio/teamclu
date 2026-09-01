import type { Catalog, Pricing, Provider, BackendModel } from "./catalog.js";

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
 * Pipe an upstream SSE body straight through while tee-ing the usage frame out
 * of it. Chunk-by-chunk: buffering the whole response first would destroy the
 * streaming experience that the agent runtime depends on.
 */
export function teeSseUsage(
  upstream: ReadableStream<Uint8Array>,
  opts: { dropUsageOnlyFrame: boolean; onUsage: (u: UpstreamUsage) => void },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Keep the trailing partial event in the buffer; SSE events are
          // separated by a blank line and a chunk can split one anywhere.
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, idx + 2);
            buf = buf.slice(idx + 2);
            controller.enqueue(encoder.encode(handleEvent(rawEvent, opts)));
          }
        }
        if (buf) controller.enqueue(encoder.encode(handleEvent(buf, opts)));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      // Client hung up -> propagate upstream so we stop paying for tokens
      // nobody will read.
      return upstream.cancel(reason);
    },
  });
}

function handleEvent(
  rawEvent: string,
  opts: { dropUsageOnlyFrame: boolean; onUsage: (u: UpstreamUsage) => void },
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

  // A usage-only frame (no choices) exists solely because we asked for it.
  // Passing it to a client that never set stream_options would be a frame it
  // does not expect.
  const isUsageOnly = usage != null && Array.isArray(obj.choices) && obj.choices.length === 0;
  if (isUsageOnly && opts.dropUsageOnlyFrame) return "";
  return rawEvent;
}
