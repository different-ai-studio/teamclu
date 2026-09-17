import type { BackendModel, Provider } from "./catalog.js";
import { classifyUpstream, type KeyPools, type PooledKey } from "./key-pool.js";
import type { PreparedRequest } from "./proxy.js";

export type PickedRoute = { backendId: string; backend: BackendModel; provider: Provider };

export type UpstreamCall = {
  pools: KeyPools;
  /** `failover` walks the routes; any other tier serves from the one route it picked. */
  failover: boolean;
  routeCount: number;
  pick: (attempt: number) => PickedRoute | null;
  prepare: (route: PickedRoute, apiKey: string) => PreparedRequest;
  fetch: typeof fetch;
  signal: AbortSignal;
};

export type UpstreamResult =
  | { ok: true; res: Response; route: PickedRoute; prepared: PreparedRequest; key: PooledKey }
  | { ok: false; response: Response; transportError?: Error };

/**
 * Keys tried on one route before giving up on it. Rejections for quota or
 * balance are fast, but each is still a round trip ahead of the caller's first
 * token — and a long list of just-expired cooldowns should not stall a request.
 */
const MAX_KEYS_PER_ROUTE = 3;

type Failure =
  | { kind: "transport"; backendId: string; error: Error }
  | { kind: "response"; backendId: string; status: number; text: string; contentType: string | null }
  | { kind: "no_keys"; backendId: string; retryAfterMs: number; onlyInvalid: boolean };

/**
 * Get one successful upstream response, switching keys and routes as needed.
 *
 * Two levels, deliberately in this order. A KEY failure (402, 429, 401) moves to
 * the next key of the same provider — same model, invisible to the caller. Only
 * when a route has no key left that can serve does a `failover` tier move to
 * its next route, which is a different model. A 5xx or an unreachable host
 * skips straight to the next route: every key reaches the same broken service.
 *
 * Switching only ever happens before a byte reaches the caller: a response that
 * started streaming belongs to the caller, errors and all.
 */
export async function callUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  let last: Failure | null = null;
  let movedOn = false;

  for (let attempt = 0; attempt < call.routeCount && !call.signal.aborted; attempt++) {
    const route = call.pick(attempt);
    if (!route) break;
    const providerId = route.backend.provider;
    const model = route.backend.upstream_model;
    const keys = call.pools.candidates(providerId, model);
    // Whether this route's failure should send a failover tier to the next one.
    // Everything except "every key was rejected": a broken key stays loud.
    let next = false;

    if (!keys.length) {
      const why = call.pools.unavailability(providerId, model);
      last = { kind: "no_keys", backendId: route.backendId, ...why };
      next = !why.onlyInvalid;
    }

    for (const key of keys.slice(0, MAX_KEYS_PER_ROUTE)) {
      if (call.signal.aborted) break;
      const prepared = call.prepare(route, key.secret);
      let res: Response;
      try {
        res = await call.fetch(prepared.url, prepared.init);
      } catch (e) {
        // Not the key's fault: every key reaches the same unreachable host.
        last = { kind: "transport", backendId: route.backendId, error: e as Error };
        console.warn(`[upstream] ${route.backendId} unreachable: ${(e as Error).message}`);
        next = true;
        break;
      }

      if (res.ok) {
        call.pools.succeeded(key, model);
        return { ok: true, res, route, prepared, key };
      }

      const text = await res.text();
      last = {
        kind: "response",
        backendId: route.backendId,
        status: res.status,
        text,
        contentType: res.headers.get("content-type"),
      };
      const verdict = classifyUpstream(res.status, res.headers, text);

      if (verdict.kind === "caller") {
        return { ok: false, response: upstreamFailure(res.status, text, last.contentType) };
      }
      if (verdict.kind === "route") {
        // Without this line a dead primary is invisible: the backstop answers,
        // and every request looks fine.
        console.warn(`[upstream] ${route.backendId} answered ${res.status}: ${text.slice(0, 300)}`);
        next = true;
        break;
      }

      const { failure } = verdict;
      const cooldown = call.pools.failed(key, model, failure, { status: res.status, error: text });
      // Error level for what a person has to fix (fund the account, replace the
      // key); a throttle clears by itself. This line, and the snapshot at
      // /internal/provider-pools, are the only places a dead key shows up once
      // the pool is routing around it.
      const say = failure.class === "rate_limited" ? console.warn : console.error;
      say(
        `[upstream] ${route.backendId} key ${key.hint} (${key.id}) answered ${res.status}: ` +
          `${failure.class} for ${failure.scope === "key" ? "the whole key" : model}, ` +
          `benched ${Math.round((cooldown.until - cooldown.at) / 1000)}s: ${text.slice(0, 300)}`,
      );
      next = !call.pools.unavailability(providerId, model).onlyInvalid;
    }

    movedOn = next;
    if (!(call.failover && next)) break;
  }

  return {
    ok: false,
    response: finalFailure(last, call.failover && movedOn),
    transportError: last?.kind === "transport" ? last.error : undefined,
  };
}

/**
 * The message when a route has no key left that can serve. Keeps the words
 * "quota exceeded" on purpose: pi retries an error that mentions 503 unless it
 * also mentions quota exceeded or billing (pi-ai `utils/retry.js`), and a pool
 * that is out of money does not refill within pi's backoff.
 */
const KEYS_EXHAUSTED_MESSAGE =
  "Every provider account serving this model is out of balance or quota right now " +
  "(upstream quota exceeded). This is not your team's credits: the operator has to fund " +
  "or add a provider account.";

const KEYS_REJECTED_MESSAGE =
  "Every provider API key serving this model was rejected by the provider. " +
  "The operator has to replace the key.";

/**
 * The message for an upstream 402. Keeps the word "billing" for the same reason
 * as above.
 */
const UPSTREAM_BILLING_MESSAGE =
  "The AI provider account serving this model is out of balance (upstream billing error). " +
  "This is not your team's credits: the operator has to fund the provider account.";

function finalFailure(last: Failure | null, exhaustedFailover: boolean): Response {
  if (!last) return errorJson(502, "upstream_error", "upstream unavailable");
  if (last.kind === "transport") {
    return errorJson(502, "upstream_error", `upstream request failed: ${last.error.message}`);
  }
  if (last.kind === "no_keys") {
    return errorJson(
      503,
      "upstream_keys_unavailable",
      last.onlyInvalid ? KEYS_REJECTED_MESSAGE : KEYS_EXHAUSTED_MESSAGE,
      { "Retry-After": String(Math.max(1, Math.ceil(last.retryAfterMs / 1000))) },
    );
  }
  // A failover tier that ran out of routes reports the last one's error in the
  // gateway's own shape; a single route passes its upstream's through.
  if (exhaustedFailover && last.status !== 402) {
    return errorJson(last.status, "upstream_error", last.text.slice(0, 500));
  }
  return upstreamFailure(last.status, last.text, last.contentType);
}

/**
 * The response for an upstream call that failed.
 *
 * Verbatim, because agent runtimes branch on the provider's own status and
 * body — with one exception. 402 is THIS gateway's answer for "your team is out
 * of credits" (`insufficient_credits`, `quota_exceeded`), while an upstream 402
 * means our own provider account is out of money. Passed through, a team with
 * plenty of credits is told to top up. It becomes a 503: from the caller's side
 * the tier is unavailable until someone funds the account. Which account is
 * logged where the key was benched.
 */
export function upstreamFailure(status: number, text: string, contentType: string | null): Response {
  if (status === 402) {
    return errorJson(503, "upstream_billing_error", UPSTREAM_BILLING_MESSAGE);
  }
  return new Response(text, {
    status,
    headers: { "Content-Type": contentType ?? "application/json" },
  });
}

function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
