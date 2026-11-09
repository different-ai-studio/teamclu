/**
 * Platform operators: the people who run THIS deployment — not a team role,
 * not an org role. They grant credits, manage the AI gateway's provider keys
 * and enter customer orgs through support sessions, which makes them the most
 * privileged identity in the product.
 *
 * Two sources, either one is enough:
 *
 * 1. `amux.is_platform_operator(user)` — an identity with admin_type 4 in the
 *    deployment's platform org (`amux.deployment_settings.platform_org_id`).
 *    This is the partner's own notion of a platform admin (saas-mono
 *    SYSTEM_ADMIN), so on Belayo the people who already run the platform are
 *    operators here too. docs/plans/2026-11-08-platform-operator-support-access.md.
 *    The price: whoever can write admin_type 4 into the platform org can make
 *    an operator. On the partner's database that is the platform admins
 *    themselves (and service_role).
 * 2. `PLATFORM_OPERATOR_USER_IDS` — auth.users ids, comma-separated. The
 *    original mechanism, kept as a fallback while deployments configure
 *    platform_org_id; to be removed.
 *
 * Ids, not emails: a phone-login account's email is synthesized
 * (PHONE_EMAIL_DOMAIN), and an id never changes. `GET /v1/admin/whoami` tells
 * anyone signed in their own id.
 *
 * Neither configured means nobody is an operator, and a failed database
 * lookup counts as "no": fail closed.
 */

import { ApiError } from "./http-utils.js";

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

/** The environment-variable source only. Prefer `resolvePlatformOperator`. */
export function isPlatformOperator(
  userId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!userId && platformOperatorIds(env).has(userId.toLowerCase());
}

/**
 * Both sources: the environment list, then `amux.is_platform_operator` through
 * a service-role client. Any failure of the lookup (no service key, RPC
 * missing because the migration has not run, network) is logged and answers
 * false.
 */
export async function resolvePlatformOperator(
  userId: string | null | undefined,
  serviceRole: () => Promise<any>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!userId) return false;
  if (isPlatformOperator(userId, env)) return true;
  try {
    const admin = await serviceRole();
    const { data, error } = await admin.schema("amux").rpc("is_platform_operator", { p_user_id: userId });
    if (error) {
      console.warn(`[operators] is_platform_operator failed: ${error.message ?? error}`);
      return false;
    }
    return data === true;
  } catch (cause) {
    console.warn(`[operators] is_platform_operator unavailable: ${(cause as Error)?.message ?? cause}`);
    return false;
  }
}

/**
 * The `session_id` claim of a bearer token, or null. Read without verifying:
 * call it only on a token the caller has already been authenticated with.
 */
export function jwtSessionId(token: string | null | undefined): string | null {
  const part = String(token ?? "").split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const sid = typeof json?.session_id === "string" ? json.session_id.toLowerCase() : "";
    return UUID.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

/** The synthetic email domain of the per-org support accounts (20261108010000). */
export const SUPPORT_EMAIL_DOMAIN = "teamclu.support";

/**
 * When `token` belongs to an org's shared support account: its user id and
 * session id (null when the token carries none). Null for every other token.
 *
 * Read without verifying, and that is enough for what it decides: whether to
 * look further. A token that merely claims to be a support account gets one
 * extra lookup and fails it; a real one cannot shed the claims without breaking
 * its signature, which Supabase checks on every call.
 */
export function supportTokenClaims(
  token: string | null | undefined,
): { userId: string; sessionId: string | null } | null {
  const part = String(token ?? "").split(".")[1];
  if (!part) return null;
  let json: any;
  try {
    json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
  const email = typeof json?.email === "string" ? json.email.toLowerCase() : "";
  const flagged = json?.app_metadata?.teamclu_support === true || email.endsWith(`@${SUPPORT_EMAIL_DOMAIN}`);
  const sub = typeof json?.sub === "string" ? json.sub.toLowerCase() : "";
  if (!flagged || !UUID.test(sub)) return null;
  const sid = typeof json?.session_id === "string" ? json.session_id.toLowerCase() : "";
  return { userId: sub, sessionId: UUID.test(sid) ? sid : null };
}

/**
 * Refuses a support account's request once the grant behind its session has
 * ended or expired. Ending a grant kills the auth session, but the access token
 * already issued stays a valid JWT for up to an hour; FC routes that act with
 * service_role after reading the caller would honour it. The database refuses
 * the same requests in its PostgREST pre-request hook
 * (amux.check_support_request); this covers the routes that never reach it
 * with the caller's token. A no-op for every other token.
 *
 * `isLive` asks the database; any failure counts as "ended": fail closed.
 */
export async function assertSupportSessionLive(
  token: string | null | undefined,
  isLive: (userId: string, sessionId: string) => Promise<boolean>,
): Promise<void> {
  const support = supportTokenClaims(token);
  if (!support) return;
  let live = false;
  if (support.sessionId) {
    try {
      live = await isLive(support.userId, support.sessionId);
    } catch (err) {
      console.warn(`[support] grant lookup failed: ${(err as Error)?.message ?? err}`);
      live = false;
    }
  }
  if (!live) {
    throw new ApiError(401, "support_session_ended", "this support session has ended");
  }
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
