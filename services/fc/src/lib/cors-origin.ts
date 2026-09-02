/**
 * CORS origin policy for the Cloud API.
 *
 * Only browser-hosted callers send an `Origin` header, so this decides which
 * web contexts may read responses. A bearer token is still required for every
 * business route; this is the second fence, not the first.
 *
 * Allowed:
 *   - the Tauri desktop app: `tauri://localhost` (macOS/Linux) and
 *     `http(s)://tauri.localhost` (Windows / production webview origin)
 *   - `http://localhost:*` and `http://127.0.0.1:*` dev servers
 *   - `chrome-extension://<id>`: the browser extension's side panel. Extension
 *     pages with host_permissions bypass CORS anyway; listing the scheme keeps
 *     the policy honest instead of relying on that.
 *   - anything listed verbatim in `CORS_ORIGINS` (comma-separated), for a
 *     browser-hosted web build.
 *
 * Everything else, including the literal `null` origin, gets no
 * `Access-Control-Allow-Origin` header. Non-browser clients (daemon, iOS, curl)
 * send no `Origin` and are unaffected.
 */

export function parseCorsOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

export function isAllowedCorsOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (!origin) return false;
  if (extra.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // An origin has no path/query; anything else is not an Origin header value.
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search || url.hash || url.username || url.password) return false;

  switch (url.protocol) {
    case "tauri:":
      return url.hostname === "localhost";
    case "chrome-extension:":
      return url.hostname.length > 0;
    case "https:":
      return url.hostname === "tauri.localhost";
    case "http:":
      return (
        url.hostname === "tauri.localhost" ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      );
    default:
      return false;
  }
}

/**
 * Value for hono's `cors({ origin })` callback: the origin to echo, or `null`
 * so the middleware omits `Access-Control-Allow-Origin` entirely.
 */
export function resolveCorsAllowOrigin(origin: string, extra: readonly string[] = []): string | null {
  return isAllowedCorsOrigin(origin, extra) ? origin : null;
}
