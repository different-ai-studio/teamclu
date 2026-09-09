import { appScheme } from '@/lib/config/build-config'

// SEC-3: the OS only ever hands this build links on its own scheme —
// `tauri.conf.json` registers exactly `[app.scheme]` (branding rewrites it per
// build) — so the deep-link parser takes that scheme and nothing else. The
// pre-rebrand `teamclaw://` is gone entirely. `amux://` is what the
// `create_team_invite` RPC still emits (see the OpenAPI description) and what a
// raw API consumer might paste, so it stays accepted for typed/pasted input
// only, where the scheme carries no security meaning.
const DEEPLINK_SCHEMES: ReadonlySet<string> = new Set([`${appScheme}:`])
const PASTED_LINK_SCHEMES: ReadonlySet<string> = new Set([`${appScheme}:`, 'amux:'])
const INVITE_HOST = 'invite'

/** Query parameter carrying the inviter's Cloud API endpoint. Same name the
 *  daemon already reads off an agent invite (`onboarding/invite_url.rs`). */
const CLOUD_API_PARAM = 'cloud_api_url'

/**
 * The invite link to hand out, always on this build's own scheme.
 *
 * Built from the token rather than passed through from the backend: the
 * `create_team_invite` RPC still returns `amux://invite?token=…`, a scheme no
 * build registers with the OS, and the pg-repo backend returns no link at all.
 *
 * `cloudApiUrl` is the inviter's *effective* endpoint, and carrying it is what
 * lets an invitee reach the right backend without being told which server to
 * type: onboarding reads it straight off the link. Omitted when the inviter has
 * no endpoint resolved at all, which is also the only case a build can have no
 * built-in default — there is nothing truthful to put in the link.
 */
export function buildInviteDeeplink(token: string, cloudApiUrl?: string | null): string {
  const base = `${appScheme}://${INVITE_HOST}?token=${encodeURIComponent(token)}`
  if (!cloudApiUrl) return base
  return `${base}&${CLOUD_API_PARAM}=${encodeURIComponent(cloudApiUrl)}`
}

/** What a parsed invite link carries. */
export interface ParsedInvite {
  token: string
  /**
   * The inviter's Cloud API endpoint, exactly as it appeared in the link, or
   * null when the link carries none (a bare token, or a link minted before
   * this parameter existed). Deliberately NOT validated here: the caller
   * probes it before persisting anything, and this module stays out of
   * server-config's import graph.
   */
  cloudApiUrl: string | null
}

function parseInviteUrl(raw: string, schemes: ReadonlySet<string>): ParsedInvite | null {
  try {
    const url = new URL(raw)
    if (!schemes.has(url.protocol)) return null
    if (url.hostname !== INVITE_HOST && url.pathname !== `//${INVITE_HOST}`) return null
    const token = url.searchParams.get('token')
    if (!token) return null
    return { token, cloudApiUrl: url.searchParams.get(CLOUD_API_PARAM) || null }
  } catch {
    return null
  }
}

/** Parse an OS-delivered deep link. Own scheme only. */
export function parseInviteDeeplink(raw: string): string | null {
  return parseInviteUrl(raw, DEEPLINK_SCHEMES)?.token ?? null
}

/**
 * Parse what the user typed or pasted: a bare token, or a link on an accepted
 * scheme. A bare token names no server, so it is claimed against whichever
 * endpoint is already in effect.
 */
export function parseInviteInput(raw: string): ParsedInvite | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fromLink = parseInviteUrl(trimmed, PASTED_LINK_SCHEMES)
  if (fromLink) return fromLink
  if (trimmed.includes('://')) return null
  return { token: trimmed, cloudApiUrl: null }
}

/** Token-only view of {@link parseInviteInput}, for callers with no server to set. */
export function parseInviteTokenInput(raw: string): string | null {
  return parseInviteInput(raw)?.token ?? null
}
