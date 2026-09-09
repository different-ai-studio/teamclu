import { ApiError } from "./http-utils.js";

/**
 * Which paths of an app sit behind its login wall.
 *
 * Two pieces: a baseline (`auth_scope`) and a list of exceptions
 * (`auth_rules`), where the LONGEST matching prefix wins. Longest-match rather
 * than list order means the rule set is declarative — an operator never has to
 * reason about which line comes first to know what a URL resolves to, which is
 * the same reason routing tables work that way.
 *
 *   scope=all,   rules=[]                              全站需要登录（默认）
 *   scope=all,   rules=[{/health, public}]             全站登录，放行 /health
 *   scope=paths, rules=[{/admin, required}]            只有 /admin 需要登录
 *   scope=paths, rules=[{/api, required},
 *                       {/api/webhook, public}]        保护 /api，放行 webhook
 *
 * Matching is by PATH PREFIX, not glob. Every real rule is a prefix
 * (`/admin`, `/api`, `/_serverFn`), while `*`/`**` would need their
 * cross-slash semantics explained to earn flexibility nobody asked for — and
 * a misunderstood glob fails in the direction of "I thought this was
 * protected".
 */

export const AUTH_SCOPES = ["all", "paths"] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export type AuthRule = { path: string; auth: "required" | "public" };

const MAX_RULES = 50;
const MAX_PATH_LEN = 512;

// --- writing: strict ---------------------------------------------------------

/**
 * Normalise one rule path, rejecting what cannot mean what its author thinks.
 *
 * A trailing `/*` is STRIPPED rather than refused. Prefix matching already
 * covers every sub-path, but `/admin/*` is what people type — and under prefix
 * semantics that would match the literal path `/admin/*`, protecting nothing,
 * silently. Silently-nothing is the worst failure available here, so the
 * intent is honoured and reported instead.
 *
 * A `*` anywhere else IS refused: it can only mean the author expected globs,
 * and quietly treating it as a literal would produce the same silent hole.
 */
export function normalizeRulePath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "auth rule path must be a string");
  }
  let path = raw.trim();
  if (!path.startsWith("/")) {
    throw new ApiError(400, "validation_failed", `auth rule path must start with "/": ${path}`);
  }
  if (path.length > MAX_PATH_LEN) {
    throw new ApiError(400, "validation_failed", "auth rule path is too long");
  }

  // Honour the two spellings of "and everything under it".
  if (path.endsWith("/*")) path = path.slice(0, -2);
  else if (path.endsWith("*")) path = path.slice(0, -1);

  if (path.includes("*")) {
    throw new ApiError(
      400,
      "validation_failed",
      `auth rule paths match by prefix, so "*" is not supported (a prefix already covers every sub-path): ${raw}`,
    );
  }

  // `/admin/` and `/admin` are the same rule; store one spelling so the
  // longest-match comparison cannot be swayed by a trailing slash.
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** Parse and validate the rule list a client is trying to store. */
export function parseAuthRules(raw: unknown): AuthRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "validation_failed", "authRules must be an array");
  }
  if (raw.length > MAX_RULES) {
    throw new ApiError(400, "validation_failed", `at most ${MAX_RULES} auth rules`);
  }

  const out: AuthRule[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new ApiError(400, "validation_failed", "each auth rule must be an object");
    }
    const auth = (entry as any).auth;
    if (auth !== "required" && auth !== "public") {
      throw new ApiError(400, "validation_failed", 'auth rule "auth" must be "required" or "public"');
    }
    const path = normalizeRulePath((entry as any).path);
    // Duplicates are refused rather than last-one-wins: two rules on the same
    // path with different verdicts have no defensible resolution, and picking
    // one silently is how a rule set stops meaning what it reads like.
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new ApiError(400, "validation_failed", `duplicate auth rule for ${path}`);
    }
    seen.add(key);
    out.push({ path, auth });
  }
  return out;
}

export function parseAuthScope(raw: unknown): AuthScope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !AUTH_SCOPES.includes(raw.trim() as AuthScope)) {
    throw new ApiError(400, "validation_failed", `authScope must be one of: ${AUTH_SCOPES.join(", ")}`);
  }
  return raw.trim() as AuthScope;
}

/**
 * Refuse a combination that claims to have a login wall while protecting
 * nothing.
 *
 * `paths` with no `required` rule is exactly that: the control panel says the
 * app requires a login and every URL is public. Falling back to `all` at
 * request time instead would contradict what the operator selected, so this is
 * caught where it is written.
 */
export function validateAuthPathConfig(scope: AuthScope, rules: AuthRule[]): void {
  if (scope === "paths" && !rules.some((r) => r.auth === "required")) {
    throw new ApiError(
      400,
      "validation_failed",
      'authScope "paths" needs at least one rule with auth "required", otherwise nothing is protected',
    );
  }
}

// --- reading: lenient input, strict conclusion -------------------------------

/**
 * A path we refuse to reason about, and therefore protect.
 *
 * `new URL().pathname` resolves `.` and `..` but does NOT decode `%2F`, so
 * `/admin%2F..%2Fsecret` reaches here intact — and an app that decodes it
 * itself would serve something our prefix check never saw. Rather than guess
 * at the app's decoding, anything carrying an encoded separator or dot segment
 * is treated as protected.
 */
function isUnreasonable(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c") || lower.includes("%2e")) return true;
  if (pathname.includes("\\")) return true;
  return pathname.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * Case-insensitive, because a static file server on macOS or Windows answers
 * `/Admin` with the same bytes as `/admin`. Matching case-sensitively would
 * leave that spelling unprotected on exactly the deployments where it resolves.
 */
function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** One stored rule, or null when the row holds something unusable. */
function readRule(entry: unknown): AuthRule | null {
  if (!entry || typeof entry !== "object") return null;
  const path = (entry as any).path;
  const auth = (entry as any).auth;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (auth !== "required" && auth !== "public") return null;
  let p = path.trim();
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return { path: p, auth };
}

/**
 * Does this request path sit behind the login wall?
 *
 * Takes the raw column values, so no caller has to pre-validate a row it read
 * from the database. Anything unusable resolves to `true`: a malformed rule set
 * must not be the reason a protected path becomes reachable, and an unknown
 * scope must not either. Writes are validated strictly, so reaching these
 * branches means something wrote to the column directly.
 */
export function pathRequiresLogin(pathname: string, scope: unknown, rawRules: unknown): boolean {
  if (isUnreasonable(pathname)) return true;

  const baseline = scope !== "paths"; // unknown scope behaves as "all"

  if (rawRules === undefined || rawRules === null) return baseline;
  if (!Array.isArray(rawRules)) return true;

  const path = pathname.toLowerCase();
  let verdict: AuthRule["auth"] | null = null;
  let bestLength = -1;

  for (const entry of rawRules) {
    const rule = readRule(entry);
    if (!rule) return true; // an unreadable rule invalidates the whole set
    const prefix = rule.path.toLowerCase();
    if (!matchesPrefix(path, prefix)) continue;
    // `/` is length 1 but is the least specific prefix there is, so it must
    // lose to every other match — score it below the empty string.
    const length = prefix === "/" ? 0 : prefix.length;
    if (length > bestLength) {
      bestLength = length;
      verdict = rule.auth;
    }
  }

  if (verdict === null) return baseline;
  return verdict === "required";
}
