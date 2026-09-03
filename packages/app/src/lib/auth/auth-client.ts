// Thin HTTP client for TeamClu's FC auth proxy endpoints (/v1/auth/*).
// Returns / consumes the raw GoTrue session shape.

import { AuthError, type AuthUser, type OtpType, type Session } from "./types";
import {
  configureSessionStore,
  getSession,
  refreshSession,
  setSession,
} from "./session-store";

interface AuthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface PhoneUser {
  id: string;
  orgId: string | null;
  orgName: string | null;
  nickname: string;
  email: string;
}

export type PhoneLoginResult =
  | { type: 'session'; session: Session }
  | { type: 'multiUser'; users: PhoneUser[] };

export type AuthClient = {
  signInWithPassword(email: string, password: string): Promise<Session>;
  sendOtp(email: string, options?: Record<string, unknown>): Promise<void>;
  verifyOtp(email: string, token: string, type?: OtpType): Promise<Session>;
  sendPhoneOtp(phone: string, options?: Record<string, unknown>): Promise<void>;
  verifyPhoneOtp(phone: string, token: string): Promise<Session>;
  /** Verify OTP and return a discriminated union — session or multi-user picker. */
  verifyPhoneOtpResult(phone: string, token: string): Promise<PhoneLoginResult>;
  /** Log in as a specific user when the phone is linked to multiple accounts. */
  loginWithPhoneUser(phone: string, token: string, userId: string): Promise<Session>;
  /** Bind a phone to the CURRENT account (partner-aligned identity upgrade). */
  bindPhone(phone: string, code: string): Promise<Session>;
  signOut(): Promise<void>;
  updateUser(attrs: Record<string, unknown>): Promise<{ user?: unknown } | null>;
  refresh(): Promise<Session>;
  oauthAuthorizeUrl(provider: string, redirect: string, codeChallenge: string): string;
  exchangeOAuthCode(code: string, codeVerifier: string): Promise<Session>;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function parseJsonOrThrow(res: Response, op: string): Promise<unknown> {
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const message =
      error?.message ||
      (typeof (data as { msg?: string } | null)?.msg === "string"
        ? (data as { msg?: string }).msg!
        : null) ||
      `${op} failed (${res.status})`;
    const code = error?.code || (data as { error?: string } | null)?.error || "auth_error";
    throw new AuthError(message, res.status, String(code));
  }
  return data;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Decode a JWT payload (base64url) without verifying — used only to recover the
// caller's identity claims, never to trust authorization.
/** True when the JWT issuer matches the configured Cloud API base URL. */
export function accessTokenMatchesBackend(
  accessToken: string,
  cloudApiUrl: string | undefined,
): boolean {
  if (!cloudApiUrl?.trim()) return true;
  const iss = decodeJwtPayload(accessToken)?.iss;
  if (typeof iss !== "string") return true;
  return iss.replace(/\/+$/, "") === cloudApiUrl.replace(/\/+$/, "");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const parsed = JSON.parse(atob(b64 + pad));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Build the user object from a GoTrue access token's claims. GoTrue access
// tokens carry sub/email/role/is_anonymous/{app,user}_metadata, which is enough
// to populate AuthUser when the refresh response itself omits the user.
function userFromAccessToken(token: string): AuthUser | null {
  const p = decodeJwtPayload(token);
  if (!p || typeof p.sub !== "string") return null;
  return {
    id: p.sub,
    email: typeof p.email === "string" ? p.email : null,
    is_anonymous: typeof p.is_anonymous === "boolean" ? p.is_anonymous : false,
    ...(p.user_metadata && typeof p.user_metadata === "object"
      ? { user_metadata: p.user_metadata as Record<string, unknown> }
      : {}),
  };
}

function normalizeRefreshSession(
  data: unknown,
  current: Session | null,
  reason: "refresh" | "adopt" = "refresh",
): Session {
  if (!data || typeof data !== "object") return data as Session;
  const row = data as Partial<Session> & {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
  if (typeof row.access_token === "string" && typeof row.refresh_token === "string") {
    return row as Session;
  }
  // FC /v1/auth/refresh returns camelCase {accessToken, refreshToken, expiresAt}
  // and NO user. Rebuild the snake_case session, preserving the live user when
  // refreshing an existing session, or — when establishing a session from a bare
  // refresh (e.g. Web SSO adopt, current === null) — derive the user from the
  // access token's own claims. Without a user, AuthGate sees no session and
  // bounces back to the login screen.
  if (typeof row.accessToken === "string" && typeof row.refreshToken === "string") {
    // A normal token renewal must retain the current profile because the
    // refresh response has no user object. An adopted token, however, is
    // deliberately minted for a different phone-linked account by
    // switch_active_team; its JWT subject is the authoritative identity.
    const tokenUser = userFromAccessToken(row.accessToken);
    const user = reason === "adopt"
      ? tokenUser ?? current?.user
      : current?.user ?? tokenUser;
    if (user) {
      return {
        ...(current ?? {}),
        access_token: row.accessToken,
        refresh_token: row.refreshToken,
        expires_at: typeof row.expiresAt === "number" ? row.expiresAt : current?.expires_at ?? null,
        token_type: current?.token_type ?? "bearer",
        user,
      } as Session;
    }
  }
  return row as Session;
}

export function createAuthClient(opts: AuthClientOptions): AuthClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = (path: string) => joinUrl(opts.baseUrl, path);

  async function post(path: string, body: unknown, bearer?: string | null) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(url(path), {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseJsonOrThrow(res, path);
  }

  async function patch(path: string, body: unknown, bearer?: string | null) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(url(path), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return parseJsonOrThrow(res, path);
  }

  function currentToken(): string | null {
    return getSession()?.access_token ?? null;
  }

  async function refresh(): Promise<Session> {
    const session = getSession();
    if (!session?.refresh_token) {
      throw new AuthError("No refresh token available.", 401, "no_refresh_token");
    }
    const data = await post("/v1/auth/refresh", { refreshToken: session.refresh_token });
    return normalizeRefreshSession(data, session);
  }

  // Wire the refresher into the SessionStore so timer-driven refreshes work.
  configureSessionStore({
    refresher: async (refreshToken: string, reason) => {
      const data = await post("/v1/auth/refresh", { refreshToken });
      return normalizeRefreshSession(data, getSession(), reason);
    },
  });

  return {
    async signInWithPassword(email, password): Promise<Session> {
      const data = (await post("/v1/auth/signin-password", { email, password })) as Session;
      setSession(data, "SIGNED_IN");
      return data;
    },
    async sendOtp(email, options) {
      await post("/v1/auth/signin-otp", { email, options });
    },
    async verifyOtp(email, token, type = "email"): Promise<Session> {
      const data = (await post("/v1/auth/verify-otp", { email, token, type })) as Session;
      setSession(data, "SIGNED_IN");
      return data;
    },
    // Partner-aligned phone login: our own SMS code + a combined login endpoint
    // (no GoTrue native OTP). See
    // docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md.
    async sendPhoneOtp(phone) {
      // Captcha verification is a server-side pass-through stub today (mirrors
      // the partner SaaS); it only needs a non-empty token. TODO: real Aliyun captcha.
      await post("/v1/auth/phone/send-code", { phone, captchaVerify: "desktop-captcha-pending" });
    },
    async verifyPhoneOtpResult(phone, token): Promise<PhoneLoginResult> {
      const res = (await post("/v1/auth/phone/login", { phone, code: token })) as
        { session?: Session; multiUser?: boolean; users?: Array<{ id: string; org_id: string | null; org_name?: string | null; nickname: string; email: string }> };
      if (res.multiUser) {
        const users: PhoneUser[] = (res.users ?? []).map((u) => ({
          id: u.id,
          orgId: u.org_id,
          orgName: u.org_name ?? null,
          nickname: u.nickname,
          email: u.email,
        }));
        return { type: 'multiUser', users };
      }
      if (!res.session) {
        throw new Error("phone login returned no session");
      }
      setSession(res.session, "SIGNED_IN");
      return { type: 'session', session: res.session };
    },
    async verifyPhoneOtp(phone, token): Promise<Session> {
      const result = await this.verifyPhoneOtpResult(phone, token);
      if (result.type === 'multiUser') {
        throw new Error("该手机号关联了多个账号，请联系管理员或使用其它登录方式。");
      }
      return result.session;
    },
    async loginWithPhoneUser(phone, token, userId): Promise<Session> {
      const res = (await post("/v1/auth/phone/login", { phone, code: token, userId })) as
        { session?: Session };
      if (!res.session) throw new Error("phone login returned no session");
      setSession(res.session, "SIGNED_IN");
      return res.session;
    },
    async bindPhone(phone, code): Promise<Session> {
      // Bind to the current account (writes public.users in the default org +
      // flips is_anonymous), then refresh to adopt the upgraded session.
      const bearer = currentToken();
      await post("/v1/account/bind-phone", { phone, code }, bearer);
      return await this.refresh();
    },
    async signOut() {
      const bearer = currentToken();
      try {
        if (bearer) await post("/v1/auth/signout", {}, bearer);
      } catch (err) {
        // Network or 401 is fine — user is being signed out locally regardless.
        console.warn("[auth] signOut request failed; clearing local session anyway", err);
      } finally {
        setSession(null, "SIGNED_OUT");
      }
    },
    async updateUser(attrs) {
      const bearer = currentToken();
      if (!bearer) throw new AuthError("Not authenticated.", 401, "no_session");
      const data = (await patch("/v1/auth/user", attrs, bearer)) as
        | { user?: unknown; session?: Session }
        | null;
      // GoTrue updateUser may return either a user or a session; merge if a
      // session shape is present.
      if (data && typeof data === "object" && "access_token" in data) {
        setSession(data as Session, "USER_UPDATED");
      } else if (data && typeof data === "object" && "user" in data) {
        const cur = getSession();
        if (cur && data.user && typeof data.user === "object") {
          setSession({ ...cur, user: { ...cur.user, ...(data.user as Record<string, unknown>) } } as Session, "USER_UPDATED");
        }
      }
      return data;
    },
    oauthAuthorizeUrl(provider, redirect, codeChallenge) {
      const u = new URL(url(`/v1/auth/oauth/${encodeURIComponent(provider)}/authorize`));
      u.searchParams.set("redirect", redirect);
      u.searchParams.set("code_challenge", codeChallenge);
      return u.toString();
    },
    async exchangeOAuthCode(code, codeVerifier): Promise<Session> {
      const data = (await post("/v1/auth/oauth/exchange", { code, codeVerifier })) as Session;
      setSession(data, "SIGNED_IN");
      return data;
    },
    refresh,
  };
}

export { refreshSession };
