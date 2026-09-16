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

export const AUTH_AUDIENCES = ["any", "org"] as const;
export type AuthAudience = (typeof AUTH_AUDIENCES)[number];

/**
 * One path rule.
 *
 * `roles` is the preferred WHO filter for `auth: "required"`: an empty list
 * means any signed-in user; a non-empty list means the visitor needs an
 * intersection with their active org role codes. `audience` is legacy-read
 * only (`any` ≡ `roles: []`, `org` ≡ any `roles_users` row) and is only
 * meaningful with `auth: "required"`. Absent `roles` AND absent `audience`
 * means "whatever the app's own `auth_audience` says" — NOT a hard-coded
 * default. Every rule stored before these keys existed is absent, so reading
 * absence as `org` would tighten the wall on every app currently set to "any
 * signed-in user", which is a live access boundary changing because a column
 * grew a key.
 */
export type AuthRule = {
  path: string;
  auth: "required" | "public";
  audience?: AuthAudience;
  roles?: string[];
};

const MAX_RULES = 50;
const MAX_PATH_LEN = 512;
const ROLE_CODE_RE = /^[a-z][a-z0-9_]*$/;

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

/** Parse and validate role codes on a required rule. Undefined = key absent. */
function parseRuleRoles(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "validation_failed", 'auth rule "roles" must be an array');
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !ROLE_CODE_RE.test(item)) {
      throw new ApiError(
        400,
        "validation_failed",
        'auth rule role codes must match /^[a-z][a-z0-9_]*$/',
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Lenient read of roles from a stored rule; null entry = unreadable. */
function readRuleRoles(raw: unknown): { ok: true; roles?: string[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !ROLE_CODE_RE.test(item)) return { ok: false };
    out.push(item);
  }
  return { ok: true, roles: out };
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

    // Dropped rather than stored on a public path: a public path admits
    // everyone by definition, so roles/audience there would be settings the
    // UI shows and the gateway ignores.
    if (auth === "public") {
      out.push({ path, auth });
      continue;
    }

    const rule: AuthRule = { path, auth };
    const roles = parseRuleRoles((entry as any).roles);
    if (roles !== undefined) rule.roles = roles;

    const rawAudience = (entry as any).audience;
    if (rawAudience !== undefined && rawAudience !== null) {
      if (typeof rawAudience !== "string" || !AUTH_AUDIENCES.includes(rawAudience.trim() as AuthAudience)) {
        throw new ApiError(
          400,
          "validation_failed",
          `auth rule "audience" must be one of: ${AUTH_AUDIENCES.join(", ")}`,
        );
      }
      rule.audience = rawAudience.trim() as AuthAudience;
    }
    out.push(rule);
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

  const rule: AuthRule = { path: p, auth };
  if (auth === "required") {
    const rolesRead = readRuleRoles((entry as any).roles);
    if (!rolesRead.ok) return null;
    if (rolesRead.roles !== undefined) rule.roles = rolesRead.roles;

    const audience = (entry as any).audience;
    if (audience !== undefined && audience !== null) {
      // Present but not a value we know: unreadable, like a bad `auth`. The
      // caller treats an unreadable rule as "protect everything", which is the
      // direction this whole file errs in.
      if (audience !== "any" && audience !== "org") return null;
      rule.audience = audience;
    }
  }
  return rule;
}

/**
 * All halves of a path's verdict, from ONE longest-prefix match: whether it
 * needs a login, and — when it does — which audience / roles satisfy it.
 *
 * Takes the raw column values, so no caller has to pre-validate a row it read
 * from the database. Anything unusable resolves to protected: a malformed rule
 * set must not be the reason a protected path becomes reachable, and an unknown
 * scope must not either. Writes are validated strictly, so reaching those
 * branches means something wrote to the column directly.
 *
 * One function rather than several because the answers must come from the same
 * winning rule. Matching twice would mean two copies of the longest-prefix
 * comparison, and the next person to touch one of them would have no way to
 * know the other existed.
 *
 * `audience: null` / `roles: null` means the winning rule did not name that
 * key (or no rule won at all). The caller falls back: explicit `roles`
 * (including `[]`) win; else legacy `audience`; else the app-level
 * `auth_audience`.
 */
export type PathPolicy = {
  requiresLogin: boolean;
  audience: AuthAudience | null;
  /** null = key absent; [] = any authenticated; non-empty = intersection. */
  roles: string[] | null;
  /**
   * True when this verdict came from the fail-safe rather than from a rule —
   * an encoded separator / dot segment, or a rule set that could not be read.
   *
   * It exists because `requiresLogin: true, roles: null, audience: null` means
   * two different things: "no rule named a WHO, use the app's own" and "I could
   * not read this, protect it". The caller must not answer the second one by
   * falling back to `auth_audience`, which is exactly how the strictest case
   * ends up admitting the widest audience.
   */
  unreadable?: boolean;
};

export function resolvePathPolicy(
  pathname: string,
  scope: unknown,
  rawRules: unknown,
): PathPolicy {
  // Fail-safe on every unusable input: protected, and under the app's own
  // audience rather than a per-path widening we could not read.
  const protectedFallback: PathPolicy = {
    requiresLogin: true,
    audience: null,
    roles: null,
    unreadable: true,
  };
  if (isUnreasonable(pathname)) return protectedFallback;

  // unknown scope behaves as "all"
  const baseline: PathPolicy = {
    requiresLogin: scope !== "paths",
    audience: null,
    roles: null,
  };

  if (rawRules === undefined || rawRules === null) return baseline;
  if (!Array.isArray(rawRules)) return protectedFallback;

  const path = pathname.toLowerCase();
  let winner: AuthRule | null = null;
  let bestLength = -1;

  for (const entry of rawRules) {
    const rule = readRule(entry);
    if (!rule) return protectedFallback; // an unreadable rule invalidates the whole set
    const prefix = rule.path.toLowerCase();
    if (!matchesPrefix(path, prefix)) continue;
    // `/` is length 1 but is the least specific prefix there is, so it must
    // lose to every other match — score it below the empty string.
    const length = prefix === "/" ? 0 : prefix.length;
    if (length > bestLength) {
      bestLength = length;
      winner = rule;
    }
  }

  if (!winner) return baseline;
  if (winner.auth !== "required") {
    return { requiresLogin: false, audience: null, roles: null };
  }
  return {
    requiresLogin: true,
    audience: winner.audience ?? null,
    roles: winner.roles !== undefined ? winner.roles : null,
  };
}
