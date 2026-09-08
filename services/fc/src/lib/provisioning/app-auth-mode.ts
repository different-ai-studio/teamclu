import { authBaseURL } from "../../auth/base-url.js";
import { appPublicUrl } from "../apps-public-host.js";
import { ApiError } from "../http-utils.js";
import { OAUTH_CLIENT_SECRET_KIND } from "./app-secrets.js";
import { type GotrueOAuthClient } from "./gotrue-oauth.js";

export const AUTH_MODES = ["none", "platform", "third"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function parseAuthMode(raw: unknown): AuthMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "authMode must be a string");
  }
  const v = raw.trim();
  if (!AUTH_MODES.includes(v as AuthMode)) {
    throw new ApiError(
      400,
      "validation_failed",
      `authMode must be one of: ${AUTH_MODES.join(", ")}`,
    );
  }
  return v as AuthMode;
}

/**
 * The app's public address, or a 409 naming what is missing.
 *
 * `platform` needs one for two reasons: it is where the login service sends the
 * visitor back to, and it is the value that service checks the return address
 * against. Without an apps domain there is nowhere to come back to, so the mode
 * is refused up front rather than at the visitor's first page load.
 */
function requireAppPublicUrl(slug: string, appId: string, env: NodeJS.ProcessEnv): string {
  const publicUrl = appPublicUrl(slug, appId, env);
  if (!publicUrl) {
    throw new ApiError(409, "vanity_required", "platform auth requires APPS_PUBLIC_DOMAIN");
  }
  return publicUrl;
}

export type AuthModeSecretOps = {
  putSecret: (kind: string, plaintext: string) => Promise<void>;
  deleteSecret: (kind: string) => Promise<void>;
};

export type AuthModeChangeDeps = {
  /** Only used to reclaim OAuth clients left by the previous design. */
  gotrue?: GotrueOAuthClient;
  gotrueUnavailableReason?: string;
  secrets: AuthModeSecretOps;
  env?: NodeJS.ProcessEnv;
};

export type AuthModeChangeInput = {
  appId: string;
  name: string;
  slug: string;
  from: AuthMode;
  to: AuthMode;
  oauthClientId: string | null;
  oauthAppId: string | null;
};

export type AuthModeChangeResult = {
  oauthClientId: string | null;
  oauthAppId: string | null;
};

/**
 * React to an `auth_mode` change.
 *
 * Turning `platform` ON provisions nothing any more. The login wall lives in
 * the FC proxy and authenticates visitors with GoTrue's email OTP endpoints,
 * which need no registered client, no client secret, and no redirect
 * allow-list entry — the last of which is what makes the wall work on a
 * customer's own domain at all, since such a domain cannot be known in advance.
 *
 * That also removed the two things that had kept this mode from ever working on
 * the live box: GoTrue's OAuth server is disabled there (`/admin/oauth/clients`
 * 404s even with a service-role token), and `APP_SECRETS_ENCRYPTION_KEY` is
 * empty, so sealing a client secret failed on the first step.
 *
 * Turning it OFF still reclaims whatever the previous design left behind.
 */
export async function applyAuthModeChange(
  deps: AuthModeChangeDeps,
  input: AuthModeChangeInput,
): Promise<AuthModeChangeResult> {
  const env = deps.env ?? process.env;
  const unchanged = { oauthClientId: input.oauthClientId, oauthAppId: input.oauthAppId };
  if (input.to === input.from) return unchanged;

  if (input.to === "platform") {
    // Fails the request rather than the visitor: an app switched to "requires
    // login" on a deployment with no apps domain would otherwise look enabled
    // and serve a misconfiguration page to everyone who opened it.
    requireAppPublicUrl(input.slug, input.appId, env);
    return unchanged;
  }

  if (input.from === "platform" && input.oauthClientId) {
    // Best effort, both halves. This is cleanup of state the current design
    // never creates, and a failure here must not stop someone turning their
    // login wall off — which is the request they actually made.
    try {
      if (deps.gotrue) await deps.gotrue.disableOAuthClient(input.oauthClientId);
    } catch (e: any) {
      console.warn(`[apps] could not reclaim oauth client for ${input.appId}: ${e?.message ?? e}`);
    }
    try {
      await deps.secrets.deleteSecret(OAUTH_CLIENT_SECRET_KIND);
    } catch (e: any) {
      console.warn(`[apps] could not delete oauth secret for ${input.appId}: ${e?.message ?? e}`);
    }
    return { oauthClientId: null, oauthAppId: null };
  }

  return unchanged;
}

/**
 * Function env for an app whose `auth_mode` is `platform`.
 *
 * None of this is what enforces the login — that happens in the proxy, before a
 * request ever reaches the function. These are a convenience so an app's own
 * code can talk to the same Supabase its visitors are registered in, on top of
 * the identity the gateway already forwards as `X-Teamclu-User-*`.
 *
 * Synchronous now, and needing neither GoTrue nor the secret store: everything
 * here is read from env.
 *
 * `SUPABASE_PUBLIC_URL` only, never `SUPABASE_URL`. The latter is typically the
 * compose-internal address (`http://kong:8000`), which a deployed function on
 * Function Compute cannot reach and a browser certainly cannot. Injecting it
 * would hand every app a URL that fails at runtime; omitting the variable
 * instead lets the app detect that the feature is unavailable.
 */
export function buildPlatformAuthEnv(
  input: { appId: string; slug: string },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {
    APP_PUBLIC_URL: requireAppPublicUrl(input.slug, input.appId, env),
    API_BASE: authBaseURL().replace(/\/+$/, ""),
  };
  const supabaseUrl = env.SUPABASE_PUBLIC_URL?.trim().replace(/\/+$/, "") || "";
  const anonKey = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  if (supabaseUrl) out.SUPABASE_URL = supabaseUrl;
  if (anonKey) out.SUPABASE_ANON_KEY = anonKey;
  return out;
}
