// Partner admin console auto-login — share the current TeamClu session with
// the partner admin SPA opened in a native webview, so it skips its own login
// screen.
//
// The admin console is a supabase-js SPA whose Supabase shares TeamClu's
// GoTrue (same JWT signing secret + user table), so the TeamClu access/refresh
// token validates there directly. supabase-js reads its session from
// localStorage under `sb-<ref>-auth-token`. We hand the storage key + the
// serialized session to the native side, which seeds it before the page bundle
// runs (see webview_create / build_supabase_session_script in webview.rs).
//
// The target host and storage key are NOT hardcoded: they come from the Cloud
// API via `/v1/config/{public,bootstrap}` (cached in server-config), the same
// source `web-sso.ts` reads. This is the reverse direction of that flow — it
// injects a session instead of harvesting one.
//
// Security (SEC-5): this hands the TeamClu bearer + refresh token to another
// origin's JavaScript, so the gate is deliberately three-fold and this module
// is the only place it is enforced:
//
//  1. Host: the Cloud-API-declared admin host (WEBSSO_LOGIN_URL), nothing else.
//  2. Path: only the login URL's own path. Injecting on every path of the host
//     meant one XSS or open redirect anywhere on the admin domain turned a
//     chat link into account takeover; the login page is the one surface the
//     SPA needs seeded.
//  3. Entry: only a tab opened through `openAdminConsoleTab()` — a first-party
//     UI action. A link inside content (agent markdown, a teammate's message,
//     a file in the editor) that happens to point at the admin host is opened
//     as a plain webview tab with no session.

import { getSession } from "@/lib/auth/session-store"
import { adminConsoleTarget } from "@/lib/auth/web-sso"
import { normalizeUrl, urlToLabel } from "@/lib/webview-utils"
import { useTabsStore } from "@/stores/tabs"

interface AdminSsoInjection {
  storageKey: string
  sessionJson: string
}

/** Login URLs opened through the explicit entry point in this app run. */
const explicitAdminEntries = new Set<string>()

/** Comparable form: normalized scheme, no fragment. `null` when unparsable. */
function canonicalHref(url: string): string | null {
  try {
    const parsed = new URL(normalizeUrl(url))
    parsed.hash = ""
    return parsed.href
  } catch {
    return null
  }
}

function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)
  return strip(a) === strip(b)
}

/**
 * The explicit admin-console entry point. Opens the Cloud-API-declared login
 * URL as an in-app webview tab and marks it eligible for session injection.
 * Returns false when no admin console is configured for this deployment.
 */
export function openAdminConsoleTab(): boolean {
  const target = adminConsoleTarget()
  if (!target) return false
  const href = canonicalHref(target.loginUrl)
  if (!href) return false
  explicitAdminEntries.add(href)
  useTabsStore.getState().openTab({
    type: "webview",
    target: target.loginUrl,
    label: urlToLabel(normalizeUrl(target.loginUrl)),
  })
  return true
}

/**
 * If `url` is the admin console login page, was opened through
 * `openAdminConsoleTab`, and a TeamClu session is present, return the storage
 * key + serialized supabase-js session to inject. Returns null otherwise (no
 * injection).
 */
export function adminSsoInjectionFor(url: string): AdminSsoInjection | null {
  const target = adminConsoleTarget()
  if (!target) return null

  const href = canonicalHref(url)
  if (!href || !explicitAdminEntries.has(href)) return null

  let parsed: URL
  let login: URL
  try {
    parsed = new URL(href)
    login = new URL(target.loginUrl)
  } catch {
    return null
  }
  if (parsed.host !== target.host) return null
  if (!samePath(parsed.pathname, login.pathname)) return null

  const session = getSession()
  if (!session?.access_token || !session.refresh_token) return null

  // supabase-js v2 persists a flat session object under its storage key.
  const supabaseSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    expires_in: session.expires_in ?? 3600,
    token_type: session.token_type ?? "bearer",
    user: session.user,
  }

  return { storageKey: target.storageKey, sessionJson: JSON.stringify(supabaseSession) }
}

/** Test-only reset hook. */
export function resetAdminSsoEntriesForTests(): void {
  explicitAdminEntries.clear()
}
