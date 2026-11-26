import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

/**
 * The fields of the local daemon's unauthenticated `GET /v1/info` that the
 * desktop reads. Other fields pass through untouched.
 */
export interface DaemonInfo {
  actor_id?: string
  device_id?: unknown
  version?: string
  mqtt_connected?: boolean
  cloud_auth?: { status?: string }
  [key: string]: unknown
}

/**
 * How long one answer is reused. Long enough to fold the back-to-back reads a
 * single check makes (`resolveAgentDevicePresence` asks for the actor id and
 * then the MQTT state — two fetches 0.1s apart, about half of all `/v1/info`
 * traffic), short enough that nothing polling on its own timer sees a value
 * older than one of its own ticks.
 */
export const DAEMON_INFO_REUSE_MS = 1_500

interface CacheState {
  at: number
  info: DaemonInfo | null
  inflight: Promise<DaemonInfo | null> | null
}

/**
 * Kept on `globalThis` so the test setup can drop it between tests without
 * importing this module (and so without defeating a test's `vi.mock` of it).
 */
const CACHE_KEY = '__teamcluDaemonInfoCache'

function cache(): CacheState {
  const g = globalThis as unknown as Record<string, CacheState | undefined>
  return (g[CACHE_KEY] ??= { at: 0, info: null, inflight: null })
}

async function fetchDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const http = await invoke<{ base_url: string } | null>('get_daemon_http_info')
    if (!http?.base_url) return null
    const resp = await fetch(`${http.base_url}/v1/info`)
    if (!resp.ok) return null
    const body: unknown = await resp.json()
    return body && typeof body === 'object' ? (body as DaemonInfo) : null
  } catch {
    return null
  }
}

/**
 * Read `/v1/info` once for everyone who asks at about the same time.
 *
 * Every reader used to fetch it itself — the MQTT status poll, the chat
 * pill's identity refresh, each reachability check (twice), onboarding,
 * settings — each after its own `get_daemon_http_info` IPC, about twelve times
 * a minute on an idle app. Concurrent callers share one request, and an answer
 * is reused for {@link DAEMON_INFO_REUSE_MS}.
 *
 * `null` means unreachable (or not in Tauri). It is reused like any answer, so
 * a down daemon is asked once per window rather than once per caller.
 */
export function readDaemonInfo(): Promise<DaemonInfo | null> {
  if (!isTauri()) return Promise.resolve(null)
  const state = cache()
  if (state.inflight) return state.inflight
  if (state.at > 0 && Date.now() - state.at < DAEMON_INFO_REUSE_MS) {
    return Promise.resolve(state.info)
  }
  const inflight = fetchDaemonInfo().then((info) => {
    state.at = Date.now()
    state.info = info
    return info
  })
  state.inflight = inflight
  const clear = () => {
    if (state.inflight === inflight) state.inflight = null
  }
  inflight.then(clear, clear)
  return inflight
}
