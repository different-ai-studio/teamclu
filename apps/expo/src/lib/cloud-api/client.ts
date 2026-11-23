// Shared TeamClu Cloud API HTTP client for Expo feature providers. Mirrors the
// transport that sessions/cloud-api.ts introduced, generalised with PATCH/DELETE
// so every feature decorator can reuse one implementation. Identity comes from
// the bearer token (getAccessToken); the FC facade derives the user server-side.

import {
  bundledCloudApiUrl,
  getCloudApiUrlOverride,
} from "./cloud-api-url";

export type CloudApiClient = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  put: <T>(path: string, body?: unknown) => Promise<T>;
  del: (path: string) => Promise<void>;
};

/**
 * Thrown for non-2xx Cloud API responses.
 *
 * Carries the HTTP status so callers can branch (404 as "absent" rather than an
 * error), and the server's machine-readable `code`. FC puts one on every error
 * (`{ error: { code, message, requestId } }`) and some of them are the whole
 * point of the response — `upgrade_required` on a member invite is not a
 * failure to report, it is a different screen to show. Matching on the message
 * string instead would break the first time someone rewords it.
 */
export class CloudApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
  }
}

/** Resolve the Cloud API base URL (cloud_api is the only client backend).
 * User override (Custom server) wins over the build-time env default. */
export function cloudApiBaseUrl(): string {
  const override = getCloudApiUrlOverride();
  if (override) return override;
  const baseUrl = bundledCloudApiUrl();
  if (!baseUrl) {
    throw new Error("EXPO_PUBLIC_CLOUD_API_URL is required (cloud_api is the only backend).");
  }
  return baseUrl;
}

/** Build a getAccessToken closure from an auth client's session — in the app
 * that is the `cloudAuth` facade (`lib/auth/cloud-auth`). */
export function cloudAccessToken(
  client: { auth: { getSession: () => Promise<{ data: { session: { access_token: string } | null } }> } },
): () => Promise<string | null> {
  return async () => {
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  };
}

function createRequestId(): string {
  return `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function createCloudApiClient(args: {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): CloudApiClient {
  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const token = await args.getAccessToken();
    if (!token) throw new Error("Missing auth session access token.");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Request-Id": createRequestId(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new CloudApiError(
        response.status,
        payload?.error?.message ?? "Cloud API request failed.",
        typeof payload?.error?.code === "string" ? payload.error.code : null,
      );
    }
    return payload as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) =>
      request<T>("POST", path, body, options),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    del: async (path: string) => {
      await request<unknown>("DELETE", path);
    },
  };
}
