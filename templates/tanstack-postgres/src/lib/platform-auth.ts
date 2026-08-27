/**
 * Platform SSO contract stub (`auth_mode=platform`). Phase 1: env helpers +
 * membership fetch only — wire `/auth/login` + `/auth/callback` routes when
 * implementing PKCE. See AGENTS.md §登录.
 *
 * Injected at deploy finalize (never commit secrets):
 * - OAUTH_CLIENT_ID — this app's public OAuth client id
 * - OAUTH_CLIENT_SECRET — server-only; token exchange at callback
 * - APP_PUBLIC_URL — vanity origin (e.g. https://slug-id8.apps.example)
 * - API_BASE — TeamClu control-plane / GoTrue origin (no trailing slash)
 */

/** Seeded from template placeholder {{APP_ID}} — this app's Cloud API id. */
export const APP_ID = '{{APP_ID}}'

export type AppMembership = { member: boolean }

/** True when platform OAuth env was injected (auth_mode=platform deploy). */
export function platformAuthConfigured(): boolean {
  return Boolean(process.env.OAUTH_CLIENT_ID && process.env.APP_PUBLIC_URL)
}

/**
 * redirect_uri registered with GoTrue. Use APP_PUBLIC_URL — not Host — because
 * the app sits behind FC reverse proxy (see AGENTS.md).
 */
export function oauthRedirectUri(): string {
  const base = process.env.APP_PUBLIC_URL?.replace(/\/+$/, '')
  if (!base) {
    throw new Error('APP_PUBLIC_URL is required for platform auth')
  }
  return `${base}/auth/callback`
}

/**
 * PKCE login (not implemented in Phase 1):
 * 1. Generate code_verifier + S256 code_challenge.
 * 2. Redirect browser to `${API_BASE}/authorize?client_id=${OAUTH_CLIENT_ID}
 *    &redirect_uri=${oauthRedirectUri()}&response_type=code&code_challenge=…
 *    &code_challenge_method=S256`.
 * 3. At `/auth/callback`, exchange code + verifier for tokens using
 *    OAUTH_CLIENT_SECRET server-side only.
 */

/**
 * Gate logged-in users: call with the end-user's bearer access token — never a
 * service role. Returns whether that user belongs to this app's team.
 */
export async function fetchAppMembership(accessToken: string): Promise<AppMembership> {
  const apiBase = process.env.API_BASE?.replace(/\/+$/, '')
  if (!apiBase) {
    throw new Error('API_BASE is required for membership check')
  }
  const res = await fetch(
    `${apiBase}/v1/apps/${encodeURIComponent(APP_ID)}/membership`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    throw new Error(`membership check failed: ${res.status}`)
  }
  return (await res.json()) as AppMembership
}
