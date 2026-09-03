import { describeJwt, redactObject, redactValue } from '@/lib/diagnostics/diag-redact'

type DiagData = Record<string, unknown>

type DiagEntry = {
  ts: string
  scope: string
  event: string
  data?: unknown
}

const MAX_ENTRIES = 300
const entries: DiagEntry[] = []

export { describeJwt } from '@/lib/diagnostics/diag-redact'

export function recordMqttDiag(scope: string, event: string, data?: unknown): void {
  const entry: DiagEntry = {
    ts: new Date().toISOString(),
    scope,
    event,
    data: data && typeof data === 'object' ? redactObject(data as DiagData) : data,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  console.info(`[diag:${scope}] ${event}`, entry.data ?? '')
}

function readJsonLocalStorage(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function localStateSnapshot(): DiagData {
  if (typeof window === 'undefined') return {}
  const auth = (readJsonLocalStorage('teamclu.session.v1') ??
    readJsonLocalStorage('teamclu.auth.session.v1')) as {
    access_token?: string | null
    refresh_token?: string | null
    expires_at?: number | null
    user?: { id?: string | null; email?: string | null; is_anonymous?: boolean | null }
  } | null
  return {
    location: window.location.href,
    visibilityState: document.visibilityState,
    serverConfig: redactValue('serverConfig', readJsonLocalStorage('teamclu.serverConfig')),
    currentTeam: redactValue('currentTeam', readJsonLocalStorage('teamclu:current-team')),
    authSession: auth
      ? {
          user: auth.user,
          accessToken: describeJwt(auth.access_token),
          refreshTokenPresent: Boolean(auth.refresh_token),
          expires_at: auth.expires_at,
        }
      : null,
  }
}

export function getMqttDiagSnapshot(extra?: DiagData): DiagData {
  return {
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    localState: typeof window !== 'undefined' ? localStateSnapshot() : {},
    extra: extra ? redactObject(extra) : undefined,
    events: entries.slice(),
  }
}

async function copyMqttDiag(extra?: DiagData): Promise<string> {
  const text = JSON.stringify(getMqttDiagSnapshot(extra), null, 2)
  try {
    await navigator.clipboard.writeText(text)
    console.info('[diag:mqtt] copied diagnostic snapshot to clipboard')
  } catch (error) {
    console.warn('[diag:mqtt] clipboard write failed; returning text', error)
  }
  return text
}

declare global {
  interface Window {
    __teamcluMqttDiag?: () => DiagData
    __teamcluCopyMqttDiag?: () => Promise<string>
  }
}

if (typeof window !== 'undefined') {
  window.__teamcluMqttDiag = () => getMqttDiagSnapshot()
  window.__teamcluCopyMqttDiag = () => copyMqttDiag()
}
