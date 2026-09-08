import { hkdfSync, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { ApiError } from "./http-utils.js";

/**
 * Session primitives for the deployed-apps login wall
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §4.5-§4.6).
 *
 * Three ticket kinds, one signing key, told apart by JWT `aud`:
 *
 *   * **SSO session** — lives on the central login domain. Holding one is what
 *     lets a visitor walk into a second app without seeing the login page.
 *   * **App session** — lives on one app's own hostname. Carries `aid`.
 *   * **Auth code** — the one-shot bearer that moves a login from the central
 *     domain to an app's hostname, because a cookie on `login.<domain>` cannot
 *     be read by `app.example.com`.
 *
 * The audience separation is load-bearing, not decoration: without it an SSO
 * cookie lifted from the central domain would verify as an app session, and the
 * `aid` check below would have nothing to fail on (an SSO ticket has no `aid`).
 *
 * These are JWTs rather than a hand-rolled `payload.hmac` for the same reason
 * `agent-management-grant.ts` is: `jose` is already a dependency and already
 * does constant-time comparison and `exp` enforcement. Rolling our own buys
 * nothing and is the kind of code that is wrong in ways tests do not catch.
 */

const ISSUER = "teamclu-fc";

const AUD_SSO = "teamclu-apps-sso";
const AUD_APP = "teamclu-apps-session";
const AUD_CODE = "teamclu-apps-code";

/** A visitor stays signed in to the platform for a month. */
export const SSO_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Per-app sessions are shorter; the SSO cookie silently renews them. */
export const APP_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Long enough for two redirects, short enough that a leaked URL is worthless. */
export const CODE_TTL_SECONDS = 60;
/** How long a spent code id is remembered. Must exceed CODE_TTL_SECONDS. */
export const SPENT_CODE_TTL_MS = 120_000;
/** Under this much life left, `shouldRenew` asks for a fresh app cookie. */
export const APP_RENEW_WINDOW_SECONDS = 24 * 60 * 60;

export const SSO_COOKIE = "__teamclu_sso";
export const APP_COOKIE = "__teamclu_app_session";

/**
 * Paths the app-domain gateway owns and never forwards to the app itself.
 *
 * They live here, next to the tickets, because BOTH sides need the exact same
 * strings: the central login service builds redirect URLs out of them, and the
 * gateway matches incoming requests against them. A copy on each side is a
 * silent 404 waiting for one of the two to be edited.
 *
 * The `__` prefix is what keeps them out of the way of a user's own routes.
 */
export const APP_AUTH_CALLBACK_PATH = "/__teamclu/auth/callback";
export const APP_AUTH_LOGOUT_PATH = "/__teamclu/auth/logout";

export type SsoSessionClaims = { sub: string; email: string };
export type AppSessionClaims = {
  sub: string;
  email: string;
  appId: string;
  /** Epoch seconds. Exposed so the gateway can decide on sliding renewal. */
  expiresAt: number;
};
export type AuthCodeClaims = {
  sub: string;
  email: string;
  appId: string;
  /** Origin the code may be redeemed on, pinned when the code was minted. */
  redirect: string;
  jti: string;
};

// --- signing key ------------------------------------------------------------

/**
 * Derived keys, memoised by the input secret so a changed env (tests, hot
 * reconfiguration) produces a different key rather than a stale one.
 */
const keyCache = new Map<string, Uint8Array>();

/**
 * The HMAC key for every ticket in this module.
 *
 * Explicit `APPS_AUTH_SESSION_SECRET` wins; otherwise the key is derived from
 * `SUPABASE_SERVICE_ROLE_KEY` with HKDF.
 *
 * The fallback is deliberate. `APP_SECRETS_ENCRYPTION_KEY` sat empty on the
 * live box for months and silently disabled the whole `platform` auth mode
 * without anyone noticing, so this feature must not ship a second env var that
 * turns it off by being unset. HKDF (not the raw key) is what keeps the derived
 * value from being usable as, or recoverable from, the service role key.
 */
function signingKey(): Uint8Array {
  const explicit = process.env.APPS_AUTH_SESSION_SECRET?.trim();
  if (explicit) {
    if (explicit.length < 32) {
      throw new ApiError(
        503,
        "apps_auth_unavailable",
        "APPS_AUTH_SESSION_SECRET must be at least 32 characters",
      );
    }
    return cached(`explicit:${explicit}`, () => new TextEncoder().encode(explicit));
  }

  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRole) {
    throw new ApiError(
      503,
      "apps_auth_unavailable",
      "app login needs APPS_AUTH_SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return cached(`derived:${serviceRole}`, () => {
    const bits = hkdfSync("sha256", serviceRole, "teamclu-apps-auth", "teamclu-apps-auth-v1", 32);
    return new Uint8Array(bits);
  });
}

function cached(key: string, make: () => Uint8Array): Uint8Array {
  const hit = keyCache.get(key);
  if (hit) return hit;
  const made = make();
  keyCache.set(key, made);
  return made;
}

// --- minting ----------------------------------------------------------------

async function mint(
  audience: string,
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(signingKey());
  return { token, expiresAt: exp };
}

export function mintSsoSession(
  claims: SsoSessionClaims,
  ttlSeconds = SSO_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  return mint(AUD_SSO, { sub: claims.sub, email: claims.email }, ttlSeconds);
}

export function mintAppSession(
  claims: Omit<AppSessionClaims, "expiresAt">,
  ttlSeconds = APP_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  return mint(AUD_APP, { sub: claims.sub, email: claims.email, aid: claims.appId }, ttlSeconds);
}

/**
 * `jti` is generated here rather than taken from the caller so there is exactly
 * one place that decides code identity — a caller reusing an id would make the
 * replay ledger silently useless.
 */
export function mintAuthCode(
  claims: Omit<AuthCodeClaims, "jti">,
  ttlSeconds = CODE_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  return mint(
    AUD_CODE,
    {
      sub: claims.sub,
      email: claims.email,
      aid: claims.appId,
      redirect: claims.redirect,
      jti: randomUUID(),
    },
    ttlSeconds,
  );
}

// --- verification -----------------------------------------------------------

/**
 * `null` means "this ticket is not valid" — an unauthenticated visitor, which
 * is an ordinary state and not an error. A missing signing key still throws:
 * that is a deployment fault, and answering "not logged in" would turn a
 * misconfigured box into an infinite redirect loop instead of a 503.
 */
async function verify(token: string, audience: string): Promise<Record<string, unknown> | null> {
  const key = signingKey();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience,
      algorithms: ["HS256"],
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function verifySsoSession(token: string): Promise<SsoSessionClaims | null> {
  const payload = await verify(token, AUD_SSO);
  if (!payload) return null;
  const claims = { sub: str(payload.sub), email: str(payload.email) };
  return claims.sub && claims.email ? claims : null;
}

/**
 * `expectedAppId` is required, not optional.
 *
 * Without it, a cookie minted for app A verifies fine on app B whenever the two
 * share a parent domain — which every vanity host does
 * (`*.apps.<domain>`). Making the caller pass the app it just resolved from the
 * Host means the check cannot be forgotten at a call site.
 */
export async function verifyAppSession(
  token: string,
  expectedAppId: string,
): Promise<AppSessionClaims | null> {
  const payload = await verify(token, AUD_APP);
  if (!payload) return null;
  const claims = {
    sub: str(payload.sub),
    email: str(payload.email),
    appId: str(payload.aid),
    expiresAt: typeof payload.exp === "number" ? payload.exp : 0,
  };
  if (!claims.sub || !claims.email || !claims.appId) return null;
  if (!expectedAppId || claims.appId !== expectedAppId) return null;
  return claims;
}

// --- one-shot codes ---------------------------------------------------------

/** jti → epoch ms after which the entry may be forgotten. */
const spentCodes = new Map<string, number>();

function sweepSpentCodes(now = Date.now()): void {
  for (const [jti, expiresAt] of spentCodes) {
    if (expiresAt <= now) spentCodes.delete(jti);
  }
}

/**
 * Redeem a code exactly once.
 *
 * Order matters: signature, then audience, then the app and origin it was
 * pinned to, and only then is the id burned. Burning first would let anyone
 * holding a code invalidate it by redeeming it against the wrong origin —
 * turning a tampered request into a denial of service on a legitimate login.
 */
export async function consumeAuthCode(
  token: string,
  expected: { appId: string; redirect: string },
): Promise<AuthCodeClaims | null> {
  const payload = await verify(token, AUD_CODE);
  if (!payload) return null;

  const claims: AuthCodeClaims = {
    sub: str(payload.sub),
    email: str(payload.email),
    appId: str(payload.aid),
    redirect: str(payload.redirect),
    jti: str(payload.jti),
  };
  if (!claims.sub || !claims.email || !claims.appId || !claims.redirect || !claims.jti) return null;
  if (claims.appId !== expected.appId) return null;
  if (claims.redirect !== expected.redirect) return null;

  const now = Date.now();
  sweepSpentCodes(now);
  if (spentCodes.has(claims.jti)) return null;
  spentCodes.set(claims.jti, now + SPENT_CODE_TTL_MS);
  return claims;
}

/** Test seam — the ledger is process-local and would otherwise leak between tests. */
export function __resetSpentCodes(): void {
  spentCodes.clear();
}

// --- cookies ----------------------------------------------------------------

/**
 * One `Set-Cookie` value.
 *
 * No `Domain` attribute, on purpose: the cookie then belongs to exactly the
 * host that set it. That is what keeps one app's session off every other app
 * under `*.apps.<domain>`, and it is why a custom domain needs its own cookie
 * rather than inheriting the central one.
 *
 * `secure` is a parameter rather than a constant so a plain-http local box can
 * still log in; every real deployment terminates TLS at Caddy and passes true.
 */
export function serializeSessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure = true,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.splice(3, 0, "Secure");
  return parts.join("; ");
}

/** Expire a cookie. Same attributes as minting, or the browser keeps the old one. */
export function clearSessionCookie(name: string, secure = true): string {
  return serializeSessionCookie(name, "", 0, secure);
}

/**
 * Pull one cookie out of a `Cookie` header.
 *
 * Splits on the first `=` only: a JWT is base64url, which never contains `=`
 * except as padding, but a value that did would otherwise be silently truncated.
 */
export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return trimmed.slice(eq + 1);
  }
  return null;
}

/**
 * Whether an app session is close enough to expiry to be worth re-issuing on
 * this response. Sliding renewal keeps an active visitor from being bounced to
 * the login domain every seventh day.
 */
export function shouldRenew(expiresAtSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return expiresAtSeconds - nowSeconds < APP_RENEW_WINDOW_SECONDS;
}
