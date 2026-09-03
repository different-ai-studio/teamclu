type DiagData = Record<string, unknown>

const SENSITIVE_KEY = /(token|password|secret|authorization|jwt)/i
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const BEARER_RE = /(Bearer\s+)\S+/gi
const JWT_INLINE_RE = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g

function decodeBase64UrlJson(segment: string): unknown {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

export function describeJwt(token: string | null | undefined): DiagData | null {
  if (!token) return null
  try {
    const payload = decodeBase64UrlJson(token.split('.')[1] ?? '') as {
      exp?: unknown
      iat?: unknown
      sub?: unknown
      role?: unknown
      aud?: unknown
    }
    const exp = typeof payload.exp === 'number' ? payload.exp : null
    const nowSec = Math.floor(Date.now() / 1000)
    return {
      kind: 'jwt',
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      aud: typeof payload.aud === 'string' ? payload.aud : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      exp,
      expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
      secondsUntilExpiry: exp ? exp - nowSec : null,
      expired: exp ? exp <= nowSec : null,
    }
  } catch {
    return { kind: 'jwt', decodeError: true }
  }
}

export function redactValue(key: string, value: unknown): unknown {
  if (value == null) return value
  if (SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string' && JWT_SHAPE.test(value)) {
      const described = describeJwt(value)
      return described?.decodeError ? '[redacted]' : described
    }
    return '[redacted]'
  }
  if (typeof value === 'string' && JWT_SHAPE.test(value)) {
    const described = describeJwt(value)
    return described?.decodeError ? value : described
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item))
  if (typeof value === 'object') return redactObject(value as DiagData)
  return value
}

export function redactObject(input: DiagData): DiagData {
  const out: DiagData = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value)
  }
  return out
}

/** Redact bearer tokens, JWTs, and API keys from plain log text. */
export function redactLogString(input: string): string {
  let out = input.replace(BEARER_RE, '$1[redacted]')
  out = out.replace(JWT_INLINE_RE, '[redacted-jwt]')
  out = out.replace(SK_RE, '[redacted-key]')
  return out
}
