import { appScheme } from '@/lib/build-config'

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

/**
 * The invite link to hand out, always on this build's own scheme.
 *
 * Built from the token rather than passed through from the backend: the
 * `create_team_invite` RPC still returns `amux://invite?token=…`, a scheme no
 * build registers with the OS, and the pg-repo backend returns no link at all.
 */
export function buildInviteDeeplink(token: string): string {
  return `${appScheme}://${INVITE_HOST}?token=${encodeURIComponent(token)}`
}

function parseInviteUrl(raw: string, schemes: ReadonlySet<string>): string | null {
  try {
    const url = new URL(raw)
    if (!schemes.has(url.protocol)) return null
    if (url.hostname !== INVITE_HOST && url.pathname !== `//${INVITE_HOST}`) return null
    const token = url.searchParams.get('token')
    return token && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Parse an OS-delivered deep link. Own scheme only. */
export function parseInviteDeeplink(raw: string): string | null {
  return parseInviteUrl(raw, DEEPLINK_SCHEMES)
}

/** Parse what the user typed or pasted: a bare token, or a link on an accepted scheme. */
export function parseInviteTokenInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fromLink = parseInviteUrl(trimmed, PASTED_LINK_SCHEMES)
  if (fromLink) return fromLink
  if (trimmed.includes('://')) return null
  return trimmed
}
