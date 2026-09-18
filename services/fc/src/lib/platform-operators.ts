/**
 * Platform operators: the people who run THIS deployment — not a team role,
 * not an org role. They grant credits and manage the AI gateway's provider
 * keys, which makes them the most privileged identity in the product.
 *
 * Who they are is `PLATFORM_OPERATOR_USER_IDS`: auth.users ids, comma-separated.
 *
 * An environment variable rather than a table or a JWT claim, on purpose:
 * - Granting it takes the same access as reading the provider keys and the
 *   gateway's service token. No bug inside the application — a missing authz
 *   check, an RLS hole — can make someone an operator.
 * - No schema. Belayo's migrations are applied by hand against a database
 *   shared with saas-mono; this adds nothing to that.
 * - Each deployment has its own database and so its own user ids; each lists
 *   its own operators.
 * The price is that changing the list means restarting FC, which is fine for a
 * list of two or three people that rarely changes.
 *
 * Ids, not emails: a phone-login account's email is synthesized
 * (PHONE_EMAIL_DOMAIN), and an id never changes. `GET /v1/admin/whoami` tells
 * anyone signed in their own id, to hand to whoever edits the deployment.
 *
 * Unset or blank means nobody is an operator: fail closed.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Entries already warned about, so a bad entry is logged once, not per request. */
const warned = new Set<string>();

export function platformOperatorIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set<string>();
  for (const raw of (env.PLATFORM_OPERATOR_USER_IDS ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    const id = raw.toLowerCase();
    if (UUID.test(id)) {
      ids.add(id);
    } else if (!warned.has(raw)) {
      // Most likely an email pasted where an id belongs. Ignored rather than
      // fatal: failing the boot over it would take the whole API down, while
      // ignoring it only denies that one entry — the safe direction.
      warned.add(raw);
      console.warn(`[operators] ignoring PLATFORM_OPERATOR_USER_IDS entry "${raw}": not a user id`);
    }
  }
  return ids;
}

export function isPlatformOperator(
  userId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!userId && platformOperatorIds(env).has(userId.toLowerCase());
}

/**
 * How many rows an operator list reads before it stops.
 *
 * The lists are sorted on values that do not live in the database being paged
 * (a team's balance lives in the gateway), so they are read whole and paged in
 * memory. The cap keeps that honest: the response says `truncated` when it bit.
 */
export const ADMIN_LIST_CAP = 2000;

/**
 * How many ids go into one PostgREST `in` filter.
 *
 * Filters travel in the query string, so a few hundred uuids is a 13 KB URL
 * and the gateway answers `URI too long` — which is what the teams list did on
 * self-host (352 teams) while every unit test passed.
 */
export const IN_FILTER_BATCH = 80;

/** Page size for an operator list: 1–200, defaulting to `fallback`. */
export function clampPage(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 200);
}

/**
 * A search term safe to splice into a PostgREST `or=(...)` filter.
 *
 * That filter is parsed as a comma-separated list with parenthesised groups, so
 * a comma or paren in the term does not error — it silently becomes a different
 * filter. `%` and `_` are the LIKE wildcards. All of them are dropped rather
 * than escaped: this is a name search box, and nobody types them on purpose.
 */
export function safeSearch(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/[,()%_*\\"'`\\]/g, "")
    .slice(0, 80);
}
