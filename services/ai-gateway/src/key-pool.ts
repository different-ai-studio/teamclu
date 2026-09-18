import { createHash } from "node:crypto";
import { parseApiKeys, type Catalog } from "./catalog.js";

/**
 * Several accounts with one provider, and which of them can take a request
 * right now.
 *
 * A provider's `api_key_env` may list several keys (`parseApiKeys`). When one
 * of them is out of money, throttled or rejected, the request moves on to the
 * next key of the SAME provider — same model, same behaviour, so the caller
 * cannot tell — and the failing key sits out a cooldown so the requests after
 * it do not pay for the same failure again. Only when no key of a route can
 * serve does a `failover` tier move on to its next route (upstream.ts).
 *
 * State is in process memory. Several replicas each learn about a failing key
 * on their own, which costs one rejected call per replica — and a rejection for
 * quota or balance is fast and consumes no tokens. Not worth a shared store.
 */

export type FailureClass =
  /** Out of balance or quota. Does not clear on its own within a request. */
  | "exhausted"
  /** Throttled. Usually clears within seconds. */
  | "rate_limited"
  /** Key rejected: wrong, revoked, or the account was closed. */
  | "invalid";

export type KeyFailure = {
  class: FailureClass;
  /**
   * `key`: the whole account is out (a 402 balance, a 401). `model`: only this
   * model on it — providers meter rate limits and subscription quotas per
   * model, so one model at its limit says nothing about the others.
   */
  scope: "key" | "model";
  /** What the upstream suggested via Retry-After, if anything. */
  hintMs?: number;
};

/** Whose problem an upstream error response is. */
export type Verdict =
  /** This account's. Another key can serve. */
  | { kind: "key"; failure: KeyFailure }
  /** The upstream's own (5xx). Every key reaches the same broken service. */
  | { kind: "route" }
  /** The request's. Nothing we switch to will accept it; pass it through. */
  | { kind: "caller" };

/**
 * Words that make a 429 a quota or balance problem rather than a throttle.
 * Measured and documented shapes it has to catch: OpenAI `insufficient_quota`,
 * `credit_balance_exhausted`, `*_spend_limit_exceeded`,
 * `organization_usage_limit_exceeded`; Codex `usage_limit_reached`; OpenCode
 * `GoUsageLimitError` / "weekly usage limit reached"; Moonshot
 * `exceeded_current_quota_error`. OpenAI's plain throttle ("Rate limit reached
 * for requests") must NOT match, which is why "limit reached" alone is not here.
 */
const QUOTA_TEXT = /quota|usage.?limit|balance|billing|credit|spend|insufficient/i;

/** A Retry-After this long is not a throttle, whatever the body says. */
const LONG_RETRY_MS = 5 * 60_000;

export function classifyUpstream(status: number, headers: Headers, text: string): Verdict {
  if (status >= 500) return { kind: "route" };
  const hintMs = retryAfterMs(headers.get("retry-after"));
  if (status === 401) return { kind: "key", failure: { class: "invalid", scope: "key" } };
  // DeepSeek's "Insufficient Balance". The account, not the model, is empty.
  if (status === 402) return { kind: "key", failure: { class: "exhausted", scope: "key", hintMs } };
  if (status === 429) {
    const exhausted = QUOTA_TEXT.test(text) || (hintMs !== undefined && hintMs >= LONG_RETRY_MS);
    return {
      kind: "key",
      failure: { class: exhausted ? "exhausted" : "rate_limited", scope: "model", hintMs },
    };
  }
  // 403 stays with the caller: across providers it means a region block, a
  // permission, or a content refusal far more often than a dead account.
  return { kind: "caller" };
}

/** Retry-After in ms: delta-seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const MIN_COOLDOWN_MS = 1_000;
const THROTTLE_DEFAULT_MS = 10_000;
const THROTTLE_MAX_MS = 60_000;
const EXHAUSTED_FIRST_MS = 60_000;
const EXHAUSTED_MAX_MS = 30 * 60_000;

/**
 * How long a key sits out, given this is failure number `strikes` of the same
 * class in a row.
 *
 * Exhausted and rejected keys back off 1, 2, 4 … minutes up to 30, and a
 * Retry-After only ever SHORTENS that. Honouring a long one is the trap: when
 * OpenCode's Go endpoint had an outage it answered every account with 429 and
 * a Retry-After of 10+ hours (opencode issue #47613), which would have benched
 * the whole pool long after the service came back. Probing a key that really
 * is empty costs one fast rejected call per window; that is the cheaper error.
 *
 * Throttles use the hint as given, bounded to a minute.
 */
export function cooldownMs(failure: KeyFailure, strikes: number): number {
  if (failure.class === "rate_limited") {
    return clamp(failure.hintMs ?? THROTTLE_DEFAULT_MS, MIN_COOLDOWN_MS, THROTTLE_MAX_MS);
  }
  const backoff = Math.min(EXHAUSTED_FIRST_MS * 2 ** Math.min(strikes - 1, 10), EXHAUSTED_MAX_MS);
  return Math.max(MIN_COOLDOWN_MS, Math.min(backoff, failure.hintMs ?? Infinity));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type PooledKey = {
  providerId: string;
  /** sha256 prefix: stable when keys are reordered, and says nothing about the key. */
  id: string;
  /** The last four characters, which is how provider consoles list keys. */
  hint: string;
  /** Priority: lower is tried first. */
  position: number;
  secret: string;
};

type Cooldown = {
  class: FailureClass;
  until: number;
  strikes: number;
  status: number;
  error: string;
  at: number;
};

type Stats = { ok: number; failed: number; lastUsedAt: number | null };

const WHOLE_KEY = "*";

export class KeyPools {
  private readonly keys = new Map<string, PooledKey[]>();
  /** `provider \0 keyId \0 model-or-*` → the cooldown on that slot. */
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly stats = new Map<string, Stats>();

  constructor(catalog: Catalog, env: NodeJS.ProcessEnv, private readonly now: () => number = Date.now) {
    for (const [providerId, p] of Object.entries(catalog.providers)) {
      this.keys.set(
        providerId,
        parseApiKeys(env[p.api_key_env]).map((secret, position) => ({
          providerId,
          id: createHash("sha256").update(secret).digest("hex").slice(0, 8),
          hint: `…${secret.slice(-4)}`,
          position,
          secret,
        })),
      );
    }
  }

  /**
   * Keys to try for this model, in the order to try them.
   *
   * Healthy keys in priority order. Priority rather than round-robin: it keeps
   * a conversation on one account, and a provider's prompt cache belongs to the
   * account — spreading requests would turn cheap cache hits into full-price
   * input. The next key is only reached when the one before it fails.
   */
  candidates(providerId: string, model: string): PooledKey[] {
    const now = this.now();
    const healthy: PooledKey[] = [];
    const throttled: { key: PooledKey; until: number }[] = [];
    for (const key of this.keys.get(providerId) ?? []) {
      const active = this.active(key, model, now);
      if (!active.length) healthy.push(key);
      else if (active.every((c) => c.class === "rate_limited")) {
        throttled.push({ key, until: Math.max(...active.map((c) => c.until)) });
      }
    }
    if (healthy.length) return healthy;
    // Nothing healthy. A throttled key is still worth trying — the alternative
    // is refusing outright, and with a pool of one that would turn a single
    // 429 into a blackout of the whole tier. An exhausted or rejected key is
    // not: it would only fail again.
    return throttled.sort((a, b) => a.until - b.until).map((t) => t.key);
  }

  /**
   * Why a provider cannot serve this model: when the soonest key comes back,
   * and whether every key is out because it was REJECTED. The latter decides
   * failover — a broken key should be loud, not quietly served elsewhere.
   */
  unavailability(providerId: string, model: string): { retryAfterMs: number; onlyInvalid: boolean } {
    const now = this.now();
    let soonest = Infinity;
    let onlyInvalid = true;
    for (const key of this.keys.get(providerId) ?? []) {
      const active = this.active(key, model, now);
      if (!active.length || active.some((c) => c.class !== "invalid")) onlyInvalid = false;
      if (active.length) soonest = Math.min(soonest, Math.max(...active.map((c) => c.until)));
    }
    return { retryAfterMs: Number.isFinite(soonest) ? soonest - now : 0, onlyInvalid };
  }

  succeeded(key: PooledKey, model: string): void {
    // Proof the account works: clears a whole-key cooldown, and this model's.
    // Another model's quota cooldown stands — it is metered separately.
    this.cooldowns.delete(this.slot(key, WHOLE_KEY));
    this.cooldowns.delete(this.slot(key, model));
    this.bump(key, "ok");
  }

  failed(key: PooledKey, model: string, failure: KeyFailure, detail: { status: number; error: string }): Cooldown {
    const slot = this.slot(key, failure.scope === "key" ? WHOLE_KEY : model);
    const prev = this.cooldowns.get(slot);
    const strikes = prev?.class === failure.class ? prev.strikes + 1 : 1;
    const now = this.now();
    const cooldown: Cooldown = {
      class: failure.class,
      until: now + cooldownMs(failure, strikes),
      strikes,
      status: detail.status,
      error: detail.error.slice(0, 300),
      at: now,
    };
    this.cooldowns.set(slot, cooldown);
    this.bump(key, "failed");
    return cooldown;
  }

  /**
   * Put keys back into service now — after topping an account up, rather than
   * waiting out its backoff. `null` for a provider the catalog does not have.
   */
  reset(providerId: string, keyId?: string): number | null {
    if (!this.keys.has(providerId)) return null;
    const prefix = keyId ? `${providerId}\0${keyId}\0` : `${providerId}\0`;
    let cleared = 0;
    for (const slot of [...this.cooldowns.keys()]) {
      if (slot.startsWith(prefix)) {
        this.cooldowns.delete(slot);
        cleared++;
      }
    }
    return cleared;
  }

  /** Everything an operator needs to see, and never a secret. */
  snapshot() {
    const now = this.now();
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return [...this.keys].map(([providerId, keys]) => ({
      providerId,
      keys: keys.map((key) => {
        const prefix = `${providerId}\0${key.id}\0`;
        const s = this.stats.get(prefix) ?? { ok: 0, failed: 0, lastUsedAt: null };
        return {
          id: key.id,
          hint: key.hint,
          position: key.position,
          ok: s.ok,
          failed: s.failed,
          lastUsedAt: iso(s.lastUsedAt),
          cooldowns: [...this.cooldowns]
            .filter(([slot]) => slot.startsWith(prefix))
            .map(([slot, c]) => {
              const model = slot.slice(prefix.length);
              return {
                model: model === WHOLE_KEY ? null : model,
                class: c.class,
                // An expired cooldown is kept for its strike count: the key is
                // back in rotation, on probation until it serves.
                active: c.until > now,
                until: iso(c.until),
                strikes: c.strikes,
                status: c.status,
                error: c.error,
                at: iso(c.at),
              };
            }),
        };
      }),
    }));
  }

  private active(key: PooledKey, model: string, now: number): Cooldown[] {
    return [this.cooldowns.get(this.slot(key, WHOLE_KEY)), this.cooldowns.get(this.slot(key, model))]
      .filter((c): c is Cooldown => !!c && c.until > now);
  }

  private slot(key: PooledKey, model: string): string {
    return `${key.providerId}\0${key.id}\0${model}`;
  }

  private bump(key: PooledKey, outcome: "ok" | "failed"): void {
    const k = `${key.providerId}\0${key.id}\0`;
    const s = this.stats.get(k) ?? { ok: 0, failed: 0, lastUsedAt: null };
    s[outcome]++;
    s.lastUsedAt = this.now();
    this.stats.set(k, s);
  }
}
