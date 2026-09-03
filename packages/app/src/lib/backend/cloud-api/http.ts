import { getFreshAccessToken, refreshSession } from "@/lib/auth/session-store";
import type { AuthBackend } from "@/lib/backend/types";

export class CloudApiError extends Error {
  status: number;
  code: string;
  requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 401 / missing session -- not a transient blip the next tick will heal. */
export function isCloudAuthError(error: unknown): boolean {
  return error instanceof CloudApiError && (error.status === 401 || error.code === "missing_auth")
}

export type CloudApiClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T>;
  patch<T>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T>;
  put<T>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T>;
  delete<T>(path: string, options?: { idempotencyKey?: string }): Promise<T>;
  postRaw<T>(path: string, body: BodyInit, options?: { contentType?: string }): Promise<T>;
  getRaw(path: string): Promise<Response>;
};

export function createCloudApiClient(args: {
  baseUrl: string;
  auth: Pick<AuthBackend, "getSession">;
  fetchImpl?: typeof fetch;
}): CloudApiClient {
  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetchImpl ?? fetch;

  async function resolveAccessToken(): Promise<string> {
    try {
      return await getFreshAccessToken();
    } catch {
      throw new CloudApiError(401, "missing_auth", "Missing auth session access token.", null);
    }
  }

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
    retried = false,
  ): Promise<T> {
    const accessToken = await resolveAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
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
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      if (response.status === 401 && !retried) {
        try {
          await refreshSession();
          return request(method, path, body, options, true);
        } catch {
          // Fall through — surface the original 401 below.
        }
      }
      const error = data?.error;
      throw new CloudApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "internal",
        typeof error?.message === "string" ? error.message : "Cloud API request failed.",
        response.headers.get("X-Request-Id") ?? error?.requestId ?? null,
      );
    }

    return data as T;
  }

  async function requestRaw(
    method: "GET" | "POST",
    path: string,
    body?: BodyInit,
    options: { contentType?: string } = {},
    retried = false,
  ): Promise<Response> {
    const accessToken = await resolveAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "X-Request-Id": createRequestId(),
    };
    if (options.contentType) headers["Content-Type"] = options.contentType;
    const response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body });
    if (response.status === 401 && !retried) {
      try {
        await refreshSession();
        return requestRaw(method, path, body, options, true);
      } catch {
        // Return the original 401 response.
      }
    }
    return response;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body, options) => request("POST", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    put: (path, body, options) => request("PUT", path, body, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
    postRaw: <T>(path: string, body: BodyInit, options?: { contentType?: string }) =>
      requestRaw("POST", path, body as BodyInit, options).then(async (res) => {
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) {
          const error = data?.error;
          throw new CloudApiError(
            res.status,
            typeof error?.code === "string" ? error.code : "internal",
            typeof error?.message === "string" ? error.message : "Cloud API request failed.",
            res.headers.get("X-Request-Id") ?? error?.requestId ?? null,
          );
        }
        return data as T;
      }),
    getRaw: (path: string) => requestRaw("GET", path),
  };
}

function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID().replace(/-/g, "").slice(0, 32);
  return Math.random().toString(36).slice(2).padEnd(12, "0").slice(0, 12);
}
