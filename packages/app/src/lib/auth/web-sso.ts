// Web SSO 快捷登录 — open the partner admin console's sign-in page in a native
// webview, let the user sign in there, then harvest the supabase-js session out
// of that page's localStorage and adopt it as the TeamClu session. The admin
// console shares TeamClu's GoTrue per environment, so its refresh_token is
// valid against TeamClu's Cloud API. This is the reverse of
// admin-sso-inject.ts.

import { getFeatures } from "@/lib/remote-features";
import { fetchPublicConfig } from "@/lib/bootstrap";
import { getEffectiveServerConfigSync } from "@/lib/server-config";
import { invoke } from "@tauri-apps/api/core";
import { AuthError } from "@/lib/auth/types";

interface SsoConfig {
  /** Full sign-in URL to load in the webview. */
  loginUrl: string;
  /** Admin host — passed to the native commands so read/clear only act here. */
  host: string;
  /** supabase-js localStorage key to read the session from. */
  storageKey: string;
}

/**
 * Resolve the partner admin console target from the Cloud-API-delivered config,
 * or null when it is not configured. The login URL + storage key are NOT
 * hardcoded: they are delivered via `/v1/config/{public,bootstrap}` (cached in
 * server-config, like the MQTT broker). The host is derived from the login URL
 * and is the only host the native read/clear/inject paths may touch.
 *
 * Shared by both directions of the admin-console session bridge: Web SSO
 * (harvest, below) and admin-sso-inject.ts (inject). Not gated on the build
 * flag — that kill switch applies to the login method, not to the target.
 */
export function adminConsoleTarget(): SsoConfig | null {
  const cfg = getEffectiveServerConfigSync();
  const loginUrl = cfg.webSsoLoginUrl;
  const storageKey = cfg.webSsoStorageKey;
  if (!loginUrl || !storageKey) return null;
  let host: string;
  try {
    host = new URL(loginUrl).host;
  } catch {
    return null;
  }
  if (!host) return null;
  return { loginUrl, host, storageKey };
}

/**
 * Resolve the SSO target, or null when the feature is off or not configured.
 *
 * `features.auth.webSSO` is the kill switch, and it is ANDed: the build must
 * have opted in AND the Cloud API must not have turned it off. A server alone
 * cannot enable it — the admin-console hosts allowed to receive an injected
 * session are compiled into the desktop binary.
 */
export function ssoConfig(): SsoConfig | null {
  if (!getFeatures().auth.webSSO) return null;
  return adminConsoleTarget();
}

// ---------------------------------------------------------------------------
// runWebSso — modal webview polling orchestration
// ---------------------------------------------------------------------------

const WEBSSO_LABEL = "websso-login";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 180_000;
const PANEL_W = 480;
const PANEL_H = 640;
/** Height of the React-rendered chrome bar above the native webview. */
const HEADER_H = 44;

let activeController: AbortController | null = null;

export interface WebSsoLayout {
  /** Chrome-bar height — the React header (with the close button) sits here. */
  headerH: number;
  /** Outer frame top-left (header + webview), in window/CSS pixels. */
  frameX: number;
  frameY: number;
  /** Outer frame size (header + webview). */
  frameW: number;
  frameH: number;
  /** Native webview rect — placed just below the header. */
  webviewX: number;
  webviewY: number;
  webviewW: number;
  webviewH: number;
}

/**
 * Compute the SSO panel geometry. Both the native webview (positioned by
 * `runWebSso`) and the React overlay (which draws the backdrop + close button)
 * derive their coordinates from this single source so the header strip lines up
 * exactly above the webview. Runs in the renderer, so `window` dims are shared.
 */
export function webSsoLayout(): WebSsoLayout {
  const frameW = PANEL_W;
  const frameH = PANEL_H + HEADER_H;
  const frameX = Math.max(0, Math.round((window.innerWidth - frameW) / 2));
  const frameY = Math.max(0, Math.round((window.innerHeight - frameH) / 2));
  return {
    headerH: HEADER_H,
    frameX,
    frameY,
    frameW,
    frameH,
    webviewX: frameX,
    webviewY: frameY + HEADER_H,
    webviewW: PANEL_W,
    webviewH: PANEL_H,
  };
}

/** Reposition the live SSO webview after a window resize (no-op if closed). */
export async function repositionWebSso(): Promise<void> {
  const l = webSsoLayout();
  await invoke("webview_set_bounds", {
    label: WEBSSO_LABEL,
    x: l.webviewX,
    y: l.webviewY,
    width: l.webviewW,
    height: l.webviewH,
  }).catch(() => {});
}

interface RunWebSsoOptions {
  pollMs?: number;
  timeoutMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AuthError("Sign-in was cancelled.", 0, "websso_cancelled"));
    }, { once: true });
  });
}

/**
 * Open the admin console sign-in page in a centered modal webview, harvest the
 * supabase session from its localStorage once the user signs in, and return the
 * harvested refresh_token. Closes the webview on every exit path. Throws
 * AuthError with code websso_cancelled | websso_timeout | websso_failed.
 */
export async function runWebSso(opts: RunWebSsoOptions = {}): Promise<string> {
  let cfg = ssoConfig();
  if (!cfg) {
    // Login-time feature: the FC-delivered target may not be cached yet (no
    // session has run the authed bootstrap). Fetch the public config on demand.
    await fetchPublicConfig();
    cfg = ssoConfig();
  }
  if (!cfg) throw new AuthError("Web SSO is not available.", 0, "websso_failed");

  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const layout = webSsoLayout();

  try {
    await invoke("webview_create", {
      label: WEBSSO_LABEL,
      url: cfg.loginUrl,
      x: layout.webviewX,
      y: layout.webviewY,
      width: layout.webviewW,
      height: layout.webviewH,
      // Force a fresh login: clear any stale admin-console session lingering in
      // the shared webview store, whose refresh token may already be consumed.
      clearStorageKey: cfg.storageKey,
    });

    for (;;) {
      if (signal.aborted) throw new AuthError("Sign-in was cancelled.", 0, "websso_cancelled");
      if (Date.now() >= deadline) throw new AuthError("Sign-in timed out.", 0, "websso_timeout");

      const raw = await invoke<string | null>("webview_read_local_storage", {
        label: WEBSSO_LABEL,
        key: cfg.storageKey,
        // Only read when the webview is actually on the FC-declared host.
        expectedHost: cfg.host,
      });
      const refreshToken = raw ? parseRefreshToken(raw) : null;
      if (refreshToken) return refreshToken;

      await delay(pollMs, signal);
    }
  } finally {
    activeController = null;
    await invoke("webview_close", { label: WEBSSO_LABEL }).catch(() => {});
  }
}

/** Abort an in-flight runWebSso (closes the webview via its finally block). */
export function cancelWebSso(): void {
  activeController?.abort();
}

function parseRefreshToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string" && parsed.refresh_token) {
      return parsed.refresh_token;
    }
  } catch {
    // not yet a complete session — keep polling
  }
  return null;
}
