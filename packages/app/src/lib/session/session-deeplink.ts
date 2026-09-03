import { appScheme, deeplinkSchemes } from '@/lib/config/build-config'

// Which schemes count as a session link is a build-level decision — see
// `resolveDeeplinkSchemes`. A build on the default scheme also takes the
// pre-rebrand `teamclaw://` and `amux://` (shared with iOS), so links already
// shared with teammates keep working; a build with its own scheme (copilot361)
// takes only that one.
const SESSION_SCHEMES = new Set(deeplinkSchemes.map((s) => `${s}:`))
const SESSION_HOST = 'session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSessionDeeplink(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!SESSION_SCHEMES.has(url.protocol)) return null
    if (url.hostname !== SESSION_HOST) return null
    // teamclu://session/<uuid> → pathname is "/<uuid>"; take the first segment.
    const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    return UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

export function buildSessionDeeplink(sessionId: string): string {
  return `${appScheme}://${SESSION_HOST}/${sessionId}`
}
