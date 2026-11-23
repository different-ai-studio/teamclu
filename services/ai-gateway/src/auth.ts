import type { Config } from "./config.js";

/**
 * Token verification, copied in behaviour from the FC supabase repo's
 * `auth.getUser` path: ask GoTrue who the token belongs to.
 *
 * The gateway holds NO signing key.
 */
export type Verifier = (token: string) => Promise<string>;

export function makeVerifier(cfg: Config): Verifier {
  return async (token) => {
    const res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.supabaseAnonKey },
    });
    if (!res.ok) throw new Error(`invalid_token (${res.status})`);
    const body = (await res.json()) as { id?: string };
    if (!body?.id) throw new Error("jwt_missing_sub");
    return body.id;
  };
}

/**
 * Caches token -> sub only.
 *
 * Deliberately NOT "token -> may access team X": a member removed from a team
 * must lose access immediately, so the actor lookup runs on every request.
 * Caching identity is safe because a token's subject never changes.
 */
export class TokenCache {
  private readonly entries = new Map<string, { sub: string; at: number }>();
  constructor(private readonly ttlMs: number, private readonly verify: Verifier) {}

  async resolve(token: string): Promise<string> {
    const hit = this.entries.get(token);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.sub;
    const sub = await this.verify(token);
    this.entries.set(token, { sub, at: now });
    if (this.entries.size > 5000) {
      for (const [k, v] of this.entries) {
        if (now - v.at >= this.ttlMs) this.entries.delete(k);
      }
    }
    return sub;
  }
}

export function bearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
