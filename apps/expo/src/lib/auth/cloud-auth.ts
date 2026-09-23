import { Buffer } from "buffer";

import {
  cloudApiBaseUrl,
  createCloudApiClient,
  type CloudApiClient,
} from "../cloud-api/client";
import {
  parsePhoneLoginResponse,
  PHONE_CAPTCHA_PLACEHOLDER,
  type PhoneLoginResult,
} from "../../features/onboarding/phone-login";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce";
import { createSessionStore, type SessionStore, type StoredSession } from "./session-store";

/**
 * Cloud-only auth client. Exposes a Supabase-`auth`-shaped facade so the app's
 * existing consumers (`supabase.auth.getSession()`, `onAuthStateChange`,
 * `setSession`, `signOut`, `getUser`, `updateUser`) and the
 * `supabaseAccessToken(client)` bearer bridge keep working unchanged, while all
 * I/O goes through the FC `/v1/auth/*` GoTrue proxy + the persisted
 * `SessionStore`. Mirrors iOS `CloudAPIAppOnboardingStore`.
 *
 * `api` is an authenticated Cloud API client (bearer sourced from the session
 * store) used by `onboarding-api` for team listing and activation.
 */

type GoTrueUser = {
  id?: string;
  email?: string | null;
  is_anonymous?: boolean;
};

type GoTrueSessionBody = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: GoTrueUser;
};

/**
 * `/v1/auth/refresh` alone is mapped by FC rather than forwarded raw, so it
 * answers in camelCase and carries no user. Every other `/v1/auth/*` endpoint
 * returns a `GoTrueSessionBody`.
 */
type RefreshedSessionBody = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type SupabaseShapedSession = {
  access_token: string;
  refresh_token: string;
  user: { id: string | null; is_anonymous: boolean; email: string | null };
};

let storeSingleton: SessionStore | null = null;
let apiSingleton: CloudApiClient | null = null;
const pkceVerifiers = new Map<string, string>();

function store(): SessionStore {
  if (!storeSingleton) {
    storeSingleton = createSessionStore({ baseUrl: cloudApiBaseUrl() });
  }
  return storeSingleton;
}

function api(): CloudApiClient {
  if (!apiSingleton) {
    apiSingleton = createCloudApiClient({
      baseUrl: cloudApiBaseUrl(),
      getAccessToken: () => store().accessToken(),
    });
  }
  return apiSingleton;
}

/**
 * Tear down auth singletons when the Cloud API base URL changes. The session
 * storage key is not URL-scoped (same as iOS keychain), so a token from server
 * A must not be replayed against server B.
 *
 * Revokes against `previousBaseUrl` when possible — by the time this runs the
 * override is already persisted and `cloudApiBaseUrl()` returns the new host.
 *
 * Does not notify auth listeners (avoids a bootstrap race mid-switch); the
 * caller is expected to `signOut` / `bootstrap` afterward.
 */
export async function tearDownCloudAuthForServerSwitch(
  previousBaseUrl: string,
): Promise<void> {
  const existing = storeSingleton;
  let token: string | null = null;
  if (existing) {
    await existing.start();
    token = existing.current()?.accessToken ?? null;
  }
  if (token) {
    const base = previousBaseUrl.replace(/\/+$/, "");
    try {
      await fetch(`${base}/v1/auth/signout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    } catch {
      // Best-effort remote revoke; always clear local state below.
    }
  }
  storeSingleton = null;
  apiSingleton = null;
  pkceVerifiers.clear();
  // Drop the shared session blob so a rebuilt store cannot reload server A's
  // tokens. Import AsyncStorage here to avoid a circular init path.
  const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
  try {
    await AsyncStorage.removeItem("teamclu.cloud-session");
  } catch {
    // In-memory singletons are already gone.
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Decode a JWT payload (best-effort) for sub/email/is_anonymous/exp. */
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function authRequest<T>(
  path: string,
  init: { method: "POST" | "PATCH"; body?: unknown; bearer?: string },
): Promise<T> {
  const baseUrl = cloudApiBaseUrl().replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Authentication request failed.");
  }
  return payload as T;
}

function errorResult(error: unknown): { data: null; error: { message: string } } {
  return {
    data: null,
    error: { message: error instanceof Error ? error.message : "Authentication request failed." },
  };
}

function expiryFrom(body: GoTrueSessionBody): number {
  if (typeof body.expires_at === "number") return body.expires_at;
  if (typeof body.expires_in === "number") return nowSeconds() + body.expires_in;
  return nowSeconds() + 3600;
}

async function storeGoTrue(body: GoTrueSessionBody): Promise<StoredSession> {
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Authentication response did not include a session.");
  }
  const next: StoredSession = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiryFrom(body),
    isAnonymous: body.user?.is_anonymous ?? false,
    email: body.user?.email ?? null,
    userId: body.user?.id ?? null,
  };
  await store().setSession(next);
  return next;
}

function toSupabaseSession(s: StoredSession | null): SupabaseShapedSession | null {
  if (!s) return null;
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    user: { id: s.userId, is_anonymous: s.isAnonymous, email: s.email },
  };
}

export type CloudAuthClient = {
  auth: {
    getSession: () => Promise<{ data: { session: SupabaseShapedSession | null } }>;
    getUser: () => Promise<{ data: { user: SupabaseShapedSession["user"] | null } }>;
    signOut: () => Promise<{ error: { message: string } | null }>;
    setSession: (input: {
      access_token: string;
      refresh_token: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    setRefreshSession: (refreshToken: string) => Promise<{ data: unknown; error: { message: string } | null }>;
    updateUser: (input: {
      email?: string;
      password?: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    onAuthStateChange: (
      callback: () => void,
    ) => { data: { subscription: { unsubscribe: () => void } } };
    signInAnonymously: () => Promise<{ data: unknown; error: { message: string } | null }>;
    signInWithOtp: (input: {
      email: string;
      options?: { shouldCreateUser?: boolean };
    }) => Promise<void>;
    signInWithPassword: (input: {
      email: string;
      password: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    verifyOtp: (input: {
      email: string;
      token: string;
      type: "email" | "email_change";
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    oauthAuthorize: (provider: string, redirectTo: string) => Promise<string>;
    exchangeOAuthCode: (code: string) => Promise<unknown>;
    /** `POST /v1/auth/phone/send-code`. Throws on failure. */
    phoneSendCode: (phone: string) => Promise<void>;
    /**
     * `POST /v1/auth/phone/login`. Stores the session when one comes back;
     * a multi-account answer stores nothing and returns the accounts.
     */
    phoneLogin: (input: {
      phone: string;
      code: string;
      userId?: string;
    }) => Promise<PhoneLoginResult>;
  };
  api: CloudApiClient;
};

export const cloudAuth: CloudAuthClient = {
  auth: {
    async getSession() {
      await store().start();
      // Refresh proactively so the returned access token is always live (the
      // MQTT password + every bearer bridge read from here).
      await store().accessToken();
      return { data: { session: toSupabaseSession(store().current()) } };
    },

    async getUser() {
      await store().start();
      const s = toSupabaseSession(store().current());
      return { data: { user: s?.user ?? null } };
    },

    async signOut() {
      await store().start();
      const token = await store().accessToken();
      if (token) {
        try {
          await authRequest("/v1/auth/signout", { method: "POST", bearer: token });
        } catch {
          // Best-effort server logout; clear local state regardless.
        }
      }
      await store().clear();
      return { error: null };
    },

    async setSession({ access_token, refresh_token }) {
      await store().start();
      try {
        const claims = decodeJwt(access_token);
        await store().setSession({
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt: typeof claims.exp === "number" ? (claims.exp as number) : nowSeconds() + 3600,
          isAnonymous: claims.is_anonymous === true,
          email: typeof claims.email === "string" ? (claims.email as string) : null,
          userId: typeof claims.sub === "string" ? (claims.sub as string) : null,
        });
        return { data: {}, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : "setSession failed" } };
      }
    },

    async setRefreshSession(refreshToken) {
      await store().start();
      try {
        // `/v1/auth/refresh` is the one auth endpoint that does NOT forward a
        // raw GoTrue body: FC maps it to camelCase
        // (`{ accessToken, refreshToken, expiresAt }` — see
        // `supabase-repo/auth.ts` and the repository contract test). Feeding it
        // to `storeGoTrue`, which reads `access_token` / `refresh_token`, found
        // neither and threw "Authentication response did not include a
        // session." — killing bootstrap for every user who has a team, since
        // `loadBootstrap` calls this right after team activation.
        const body = await authRequest<RefreshedSessionBody>("/v1/auth/refresh", {
          method: "POST",
          body: { refreshToken },
        });
        if (!body.accessToken || !body.refreshToken) {
          throw new Error("Authentication response did not include a session.");
        }
        const previous = store().current();
        await store().setSession(
          {
            accessToken: body.accessToken,
            refreshToken: body.refreshToken,
            expiresAt: body.expiresAt ?? nowSeconds() + 3600,
            // The refresh response carries no user, so identity fields come
            // from the session being replaced — this swaps tokens, not
            // accounts.
            isAnonymous: previous?.isAnonymous ?? false,
            email: previous?.email ?? null,
            userId: previous?.userId ?? null,
          },
          // Silent because `loadBootstrap` calls this mid-bootstrap: notifying
          // re-enters `bootstrap()`, which invalidates the in-flight run and
          // loops forever on "Opening TeamClu". Nobody needs waking — the
          // access token is always read live through `accessToken()`.
          { silent: true },
        );
        return { data: {}, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : "setRefreshSession failed" } };
      }
    },

    async updateUser(input) {
      await store().start();
      try {
        const token = await store().accessToken();
        if (!token) throw new Error("Not authenticated.");
        const body = await authRequest<GoTrueSessionBody>("/v1/auth/user", {
          method: "PATCH",
          body: input,
          bearer: token,
        });
        // PATCH may return fresh tokens (rare) or just the updated user.
        if (body.access_token && body.refresh_token) {
          await storeGoTrue(body);
        }
        return { data: body, error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : "updateUser failed" },
        };
      }
    },

    onAuthStateChange(callback) {
      const unsubscribe = store().subscribe(callback);
      return { data: { subscription: { unsubscribe } } };
    },

    async signInAnonymously() {
      await store().start();
      const body = await authRequest<GoTrueSessionBody>("/v1/auth/signin-anonymous", {
        method: "POST",
        body: {},
      });
      await storeGoTrue(body);
      return { data: {}, error: null };
    },

    async signInWithOtp({ email, options }) {
      await store().start();
      await authRequest("/v1/auth/signin-otp", {
        method: "POST",
        body: { email, options: { shouldCreateUser: options?.shouldCreateUser ?? true } },
      });
    },

    /**
     * Email + password sign-in, matching iOS
     * `CloudAPIAppOnboardingStore.signIn(email:password:)`.
     *
     * Returns the error rather than throwing, like `verifyOtp` — a wrong
     * password is an ordinary outcome the form has to render, not an exception.
     */
    async signInWithPassword({ email, password }) {
      await store().start();
      try {
        const body = await authRequest<GoTrueSessionBody>("/v1/auth/signin-password", {
          method: "POST",
          body: { email, password },
        });
        if (!body.access_token || !body.refresh_token) {
          return { data: null, error: { message: "Sign-in did not return a session." } };
        }
        await storeGoTrue(body);
        return { data: body, error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : "Sign-in failed" },
        };
      }
    },

    async verifyOtp({ email, token, type }) {
      await store().start();
      // Store a session only when the response carries one (sign-in OTP does;
      // an `email_change` confirmation keeps the existing user/session).
      const consume = async (body: GoTrueSessionBody) => {
        if (body.access_token && body.refresh_token) await storeGoTrue(body);
        return { data: body, error: null as { message: string } | null };
      };
      try {
        const body = await authRequest<GoTrueSessionBody>("/v1/auth/verify-otp", {
          method: "POST",
          body: { email, token, type },
        });
        return await consume(body);
      } catch (error) {
        // Mirror the legacy store: for sign-in OTP, fall back to type "signup".
        if (type === "email") {
          try {
            const body = await authRequest<GoTrueSessionBody>("/v1/auth/verify-otp", {
              method: "POST",
              body: { email, token, type: "signup" },
            });
            return await consume(body);
          } catch (retryError) {
            return errorResult(retryError);
          }
        }
        return errorResult(error);
      }
    },

    async oauthAuthorize(provider, redirectTo) {
      await store().start();
      const verifier = generateCodeVerifier();
      const challenge = codeChallengeFromVerifier(verifier);
      pkceVerifiers.set(provider, verifier);
      const baseUrl = cloudApiBaseUrl().replace(/\/+$/, "");
      const params = new URLSearchParams({ redirect: redirectTo, code_challenge: challenge });
      return `${baseUrl}/v1/auth/oauth/${encodeURIComponent(provider)}/authorize?${params.toString()}`;
    },

    async exchangeOAuthCode(code) {
      await store().start();
      // The verifier is keyed by provider; we don't know which provider the
      // callback came from, so take the most recent (there is only one
      // in-flight OAuth attempt at a time).
      const verifier = [...pkceVerifiers.values()].pop();
      pkceVerifiers.clear();
      if (!verifier) throw new Error("No PKCE verifier for OAuth exchange.");
      const body = await authRequest<GoTrueSessionBody>("/v1/auth/oauth/exchange", {
        method: "POST",
        body: { code, codeVerifier: verifier },
      });
      await storeGoTrue(body);
      return body;
    },

    async phoneSendCode(phone) {
      await store().start();
      await authRequest("/v1/auth/phone/send-code", {
        method: "POST",
        body: { phone, captchaVerify: PHONE_CAPTCHA_PLACEHOLDER },
      });
    },

    async phoneLogin({ phone, code, userId }) {
      await store().start();
      // FC accepts camelCase `userId` (and snake_case `user_id`); the desktop
      // auth client sends camelCase too.
      const body = await authRequest<unknown>("/v1/auth/phone/login", {
        method: "POST",
        body: userId ? { phone, code, userId } : { phone, code },
      });
      const result = parsePhoneLoginResponse(body);
      if (result.type === "session") {
        await storeGoTrue(result.session);
      }
      return result;
    },
  },

  get api() {
    return api();
  },
};
