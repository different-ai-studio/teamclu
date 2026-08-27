import { ApiError } from "../http-utils.js";

type Env = NodeJS.ProcessEnv;

export interface GotrueOAuthConfig {
  /** GoTrue base including `/auth/v1`. */
  authUrl: string;
  serviceRoleKey: string;
}

export type GotrueOAuthConfigResolution =
  | { config: GotrueOAuthConfig; error?: undefined }
  | { config?: undefined; error: string };

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * 503 when platform OAuth provisioning needs GoTrue admin but env is incomplete.
 * `reason` names the empty variable so operators know which knob to turn.
 */
export function oauthUnavailable(reason?: string): ApiError {
  return new ApiError(
    503,
    "oauth_unavailable",
    reason ? `oauth not configured: ${reason}` : "oauth not configured",
  );
}

/** Resolve GoTrue admin credentials from env already declared in s.yaml. */
export function readGotrueOAuthConfig(env: Env = process.env): GotrueOAuthConfigResolution {
  const projectUrl = trimmed(env.GOTRUE_URL) || trimmed(env.FC_SUPABASE_URL) || trimmed(env.SUPABASE_URL);
  if (!projectUrl) return { error: "SUPABASE_URL is empty" };
  const serviceRoleKey = trimmed(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!serviceRoleKey) return { error: "SUPABASE_SERVICE_ROLE_KEY is empty" };
  const base = projectUrl.replace(/\/+$/, "");
  return {
    config: {
      authUrl: base.endsWith("/auth/v1") ? base : `${base}/auth/v1`,
      serviceRoleKey,
    },
  };
}

export type GotrueOAuthClientOptions = GotrueOAuthConfig & {
  fetch?: typeof fetch;
};

type OAuthClientResponse = {
  id?: string;
  client_id?: string;
  client_secret?: string;
};

/** Admin client for GoTrue OAuth 2.1 server dynamic registration (§6.5). */
export function makeGotrueOAuthClient(opts: GotrueOAuthClientOptions) {
  const authUrl = opts.authUrl.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;

  async function adminFetch(path: string, init: RequestInit = {}) {
    const res = await fetchFn(`${authUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.serviceRoleKey}`,
        "Content-Type": "application/json",
        apikey: opts.serviceRoleKey,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(
        res.status >= 500 ? 502 : res.status,
        "gotrue_oauth_error",
        detail || res.statusText || "gotrue oauth request failed",
      );
    }
    return res;
  }

  function mapCreated(data: OAuthClientResponse) {
    const clientId = data.client_id?.trim();
    const clientSecret = data.client_secret?.trim();
    if (!clientId || !clientSecret) {
      throw new ApiError(502, "gotrue_oauth_error", "create oauth client returned no client_id or client_secret");
    }
    return {
      /** Internal row id when GoTrue returns one; otherwise null. */
      id: data.id?.trim() || null,
      clientId,
      clientSecret,
    };
  }

  return {
    async createOAuthClient(input: { name: string; redirectUris: string[] }) {
      const res = await adminFetch("/admin/oauth/clients", {
        method: "POST",
        body: JSON.stringify({
          client_name: input.name,
          redirect_uris: input.redirectUris,
          client_type: "confidential",
          token_endpoint_auth_method: "client_secret_basic",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      return mapCreated((await res.json()) as OAuthClientResponse);
    },

    async updateOAuthClient(clientId: string, input: { redirectUris: string[] }) {
      await adminFetch(`/admin/oauth/clients/${encodeURIComponent(clientId)}`, {
        method: "PUT",
        body: JSON.stringify({ redirect_uris: input.redirectUris }),
      });
    },

    /** GoTrue has no soft-disable; delete removes the registration (§6.5). */
    async disableOAuthClient(clientId: string) {
      const res = await fetchFn(`${authUrl}/admin/oauth/clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${opts.serviceRoleKey}`,
          apikey: opts.serviceRoleKey,
        },
      });
      if (res.status === 404) return;
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ApiError(
          res.status >= 500 ? 502 : res.status,
          "gotrue_oauth_error",
          detail || res.statusText || "gotrue oauth delete failed",
        );
      }
    },
  };
}

export type GotrueOAuthClient = ReturnType<typeof makeGotrueOAuthClient>;
