import { authBaseURL } from "../../auth/base-url.js";
import { appPublicUrl } from "../apps-public-host.js";
import { resolveBackendKind } from "../backend-kind.js";
import { ApiError } from "../http-utils.js";
import { getAppSecret, OAUTH_CLIENT_SECRET_KIND } from "./app-secrets.js";
import { oauthUnavailable, type GotrueOAuthClient } from "./gotrue-oauth.js";

export const AUTH_MODES = ["none", "platform", "third"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oauthAppIdOrNull(raw: string | null): string | null {
  if (!raw) return null;
  return UUID_RE.test(raw) ? raw : null;
}

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

/** §6.7 — Better Auth self-host has no OAuth authorization server. */
export function assertPlatformAuthAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (resolveBackendKind(env) === "postgres") {
    throw new ApiError(
      409,
      "platform_auth_unavailable",
      "platform auth requires the supabase control-plane backend (GoTrue); self-hosted Better Auth deployments must use authMode none or third",
    );
  }
}

function platformRedirectUri(slug: string, appId: string, env: NodeJS.ProcessEnv = process.env): string {
  const publicUrl = appPublicUrl(slug, appId, env);
  if (!publicUrl) {
    throw new ApiError(409, "vanity_required", "platform auth requires APPS_PUBLIC_DOMAIN");
  }
  return `${publicUrl}/auth/callback`;
}

export type AuthModeSecretOps = {
  putSecret: (kind: string, plaintext: string) => Promise<void>;
  deleteSecret: (kind: string) => Promise<void>;
};

export type AuthModeChangeDeps = {
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

/** Provision or tear down GoTrue OAuth state when authMode changes (§6.5). */
export async function applyAuthModeChange(
  deps: AuthModeChangeDeps,
  input: AuthModeChangeInput,
): Promise<AuthModeChangeResult> {
  const env = deps.env ?? process.env;
  if (input.to === input.from) {
    return { oauthClientId: input.oauthClientId, oauthAppId: input.oauthAppId };
  }

  if (input.to === "platform") {
    assertPlatformAuthAllowed(env);
    if (!deps.gotrue) throw oauthUnavailable(deps.gotrueUnavailableReason);
    const redirectUri = platformRedirectUri(input.slug, input.appId, env);

    if (input.oauthClientId) {
      await deps.gotrue.updateOAuthClient(input.oauthClientId, { redirectUris: [redirectUri] });
      return { oauthClientId: input.oauthClientId, oauthAppId: input.oauthAppId };
    }

    const created = await deps.gotrue.createOAuthClient({
      name: `TeamClu app ${input.name} (${input.appId})`,
      redirectUris: [redirectUri],
    });
    await deps.secrets.putSecret(OAUTH_CLIENT_SECRET_KIND, created.clientSecret);
    return {
      oauthClientId: created.clientId,
      oauthAppId: oauthAppIdOrNull(created.id),
    };
  }

  if (input.from === "platform" && input.oauthClientId) {
    if (deps.gotrue) {
      await deps.gotrue.disableOAuthClient(input.oauthClientId);
    }
    await deps.secrets.deleteSecret(OAUTH_CLIENT_SECRET_KIND);
    // Clear the ids along with the registration they name. GoTrue has no
    // soft-disable — `disableOAuthClient` is a hard DELETE — and the secret is
    // gone too, so keeping them "for audit" only made platform auth
    // un-re-enableable: switching back took the update branch above and 404'd
    // on a client id that no longer exists.
    return { oauthClientId: null, oauthAppId: null };
  }

  return { oauthClientId: input.oauthClientId, oauthAppId: input.oauthAppId };
}

export type PlatformOAuthFinalizeDeps = {
  gotrue?: GotrueOAuthClient;
  gotrueUnavailableReason?: string;
  getSecret: (kind: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
};

/** Decrypt secret, refresh redirect, and build FC env for platform auth finalize. */
export async function buildPlatformOAuthEnv(
  deps: PlatformOAuthFinalizeDeps,
  input: { appId: string; slug: string; oauthClientId: string | null },
): Promise<Record<string, string>> {
  const env = deps.env ?? process.env;
  if (!input.oauthClientId) {
    throw new ApiError(
      409,
      "oauth_not_provisioned",
      "platform auth app has no OAuth client; set authMode to platform first",
    );
  }
  if (!deps.gotrue) throw oauthUnavailable(deps.gotrueUnavailableReason);

  const publicUrl = appPublicUrl(input.slug, input.appId, env);
  if (!publicUrl) {
    throw new ApiError(409, "vanity_required", "platform auth requires APPS_PUBLIC_DOMAIN");
  }
  const redirectUri = `${publicUrl}/auth/callback`;
  await deps.gotrue.updateOAuthClient(input.oauthClientId, { redirectUris: [redirectUri] });

  const secret = await deps.getSecret(OAUTH_CLIENT_SECRET_KIND);
  if (!secret) {
    throw new ApiError(503, "app_secrets_unavailable", "oauth client secret missing from app_secrets");
  }

  return {
    OAUTH_CLIENT_ID: input.oauthClientId,
    OAUTH_CLIENT_SECRET: secret,
    APP_PUBLIC_URL: publicUrl,
    API_BASE: authBaseURL().replace(/\/+$/, ""),
  };
}

/** pg-repo helper — reads app_secrets via Drizzle. */
export async function buildPlatformOAuthEnvPg(
  deps: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any;
    gotrue?: GotrueOAuthClient;
    gotrueUnavailableReason?: string;
    env?: NodeJS.ProcessEnv;
  },
  input: { appId: string; slug: string; oauthClientId: string | null },
): Promise<Record<string, string>> {
  return buildPlatformOAuthEnv(
    {
      ...deps,
      getSecret: (kind) => getAppSecret(deps.db, input.appId, kind),
    },
    input,
  );
}
