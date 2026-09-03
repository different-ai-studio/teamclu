import { create } from 'zustand'

function logMqttNetworkDiag(event: string, data?: Record<string, unknown>): void {
  void import('@/lib/mqtt/mqtt-diagnostics')
    .then(({ recordMqttDiag }) => {
      recordMqttDiag('mqtt-reconnect', event, data)
    })
    .catch(() => {})
}

interface MqttReconnectState {
  nonce: number
  /**
   * Shared MQTT connection state as reported by the Rust side. `null` = unknown
   * yet (initial probe in flight, or non-Tauri context). This is the single
   * source of truth: every consumer reads it via `useMqttConnected`, so
   * independent components (settings card, sidebar notice) can never disagree.
   */
  connected: boolean | null
  /**
   * Last MQTT connection error surfaced from the Rust event loop (e.g. a
   * broker auth rejection), or null when the connection is healthy / unknown.
   */
  lastError: string | null
  /** Internal: whether the global probe + listener have been wired. */
  _wired: boolean
  /** Trigger a reconnect attempt. Clears any stale error so the retry is clean. */
  bump: () => void
  /** Record the latest connection error, or pass null to clear it. */
  setError: (message: string | null) => void
  /** Update the shared connection state; a successful connect clears the error. */
  setConnected: (connected: boolean | null) => void
  /**
   * Wire the single source of truth for MQTT state, once. Does an initial
   * `mqtt_status` probe, attaches one `mqtt:connected` / `mqtt:error` listener,
   * re-probes right after attaching (closes the listen-attach race), then
   * re-probes slowly on an interval (self-heals any missed event). Idempotent
   * and Tauri-only — every consumer calls it but only the first does the work.
   */
  ensureWired: () => void
}

/** Hidden longer than this before visibility resume counts as sleep/wake. */
export const MQTT_SLEEP_WAKE_HIDDEN_MS = 60_000

export function daemonMqttNeedsRecovery(
  snapshot: { connected: boolean; phase: string } | null,
  fallbackConnected: boolean | null,
): boolean {
  if (snapshot) return !snapshot.connected && snapshot.phase !== 'Stopped'
  return fallbackConnected !== true
}

/** True when the broker rejected MQTT credentials (expired JWT after sleep, etc.). */
export function isMqttAuthFailure(message: string): boolean {
  const m = message.toLowerCase()
  const compact = m.replace(/[^a-z0-9]/g, '')
  const authCode =
    compact.includes('badusernamepassword') ||
    compact.includes('badusernameorpassword') ||
    compact.includes('notauthorized')
  if (!authCode) return false
  if (m.includes('broker refused connection')) return true
  if (m.includes('connection refused') && m.includes('return code')) return true
  if (m.includes('connection refused')) return true
  return false
}

/** Whether a visibility resume should refresh session credentials (vs bump-only). */
export function shouldAutoRecoverMqttAfterVisibility(input: {
  wasDiscarded: boolean
  hiddenMs: number
}): boolean {
  return input.wasDiscarded || input.hiddenMs >= MQTT_SLEEP_WAKE_HIDDEN_MS
}

/**
 * Grace window for mqtt.js transport-level auto-reconnect (browser path)
 * before the store escalates to credential refresh + client rebuild.
 * Several reconnectPeriod (3s) attempts fit inside it.
 */
export const BROWSER_RECONNECT_GRACE_MS = 15_000

const AUTH_RECOVERY_COOLDOWN_MS = 10_000
let lastAuthRecoveryMs = 0
let authRecoveryInFlight: Promise<void> | null = null
let hiddenAtMs: number | null = null
/** Bumped on sign-out so in-flight recovery cannot refresh or bump afterward. */
let recoveryGeneration = 0

type RecoverMode = 'auto' | 'user'

type RecoveryReason =
  | 'startup'
  | 'visibility_resume'
  | 'long_visibility_resume'
  | 'network_online'
  | 'user_requested'
  | 'credential_rejected'

async function runMqttRecovery(
  get: () => MqttReconnectState,
  generation: number,
  reason: RecoveryReason,
): Promise<void> {
  if (generation !== recoveryGeneration) return
  const utils = await import('@/lib/utils')
  if (utils.isTauri() && reason !== 'user_requested' && reason !== 'credential_rejected') {
    const { getDaemonMqttSnapshot } = await import('@/lib/daemon/daemon-local-client')
    const snapshot = await getDaemonMqttSnapshot()
    if (snapshot?.connected) {
      get().setConnected(true)
      void import('@/lib/daemon/daemon-probe-signal')
        .then((m) => m.requestDaemonProbe())
        .catch(() => {})
      return
    }
  }
  const tasks: Promise<unknown>[] = []
  if (utils.isTauri()) {
    tasks.push(
      import('@/lib/daemon/daemon-local-client')
        .then(({ recoverDaemonMqtt }) => recoverDaemonMqtt(reason))
        .catch(() => undefined),
    )
  }
  tasks.push(
    import('@/lib/auth/session-store')
      .then(({ refreshSession }) => refreshSession())
      .catch(() => undefined),
  )
  await Promise.all(tasks)
  if (generation !== recoveryGeneration) return
  get().bump()
  void import('@/lib/daemon/daemon-probe-signal')
    .then((m) => m.requestDaemonProbe())
    .catch(() => {})
}

async function recoverMqttCredentials(
  get: () => MqttReconnectState,
  mode: RecoverMode = 'auto',
  reason: RecoveryReason = mode === 'user' ? 'user_requested' : 'visibility_resume',
): Promise<void> {
  if (authRecoveryInFlight) {
    if (mode === 'user') {
      await authRecoveryInFlight.catch(() => {})
    } else {
      return authRecoveryInFlight
    }
  }

  const now = Date.now()
  if (mode === 'auto' && now - lastAuthRecoveryMs < AUTH_RECOVERY_COOLDOWN_MS) return

  lastAuthRecoveryMs = now
  const generation = recoveryGeneration
  authRecoveryInFlight = runMqttRecovery(get, generation, reason).finally(() => {
    authRecoveryInFlight = null
  })
  return authRecoveryInFlight
}

/** Refresh session credentials and trigger a Desktop MQTT reconnect (user-initiated). */
export function recoverMqttConnection(): Promise<void> {
  return recoverMqttCredentials(() => useMqttReconnectStore.getState(), 'user')
}

/** Clear recovery state on sign-out (aborts in-flight recovery, resets store). */
export function resetMqttReconnectRecovery(): void {
  recoveryGeneration++
  lastAuthRecoveryMs = 0
  authRecoveryInFlight = null
  hiddenAtMs = null
  useMqttReconnectStore.setState({
    nonce: 0,
    connected: null,
    lastError: null,
  })
}

export const useMqttReconnectStore = create<MqttReconnectState>((set, get) => ({
  nonce: 0,
  connected: null,
  lastError: null,
  _wired: false,
  bump: () => set({ nonce: get().nonce + 1, lastError: null }),
  setError: (message) => set({ lastError: message }),
  setConnected: (connected) =>
    set(connected ? { connected, lastError: null } : { connected }),
  ensureWired: () => {
    if (get()._wired) return
    set({ _wired: true })
    // Tauri APIs are loaded dynamically so this store module stays import-light
    // (only `zustand`) and unit-testable in a non-Tauri/jsdom env.
    void (async () => {
      const utils = await import('@/lib/utils').catch(() => null)
      if (!utils) return
      // Network came back: force a fast credential-refresh + reconnect and an
      // immediate daemon status re-probe, rather than waiting out the Rust
      // event loop's ≤60s backoff and the 20s status poll. `recoverMqttCredentials`
      // (auto mode) is cooldown-throttled so a flapping link can't spam it.
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          void recoverMqttCredentials(get, 'auto', 'network_online')
          void import('@/lib/daemon/daemon-probe-signal')
            .then((m) => m.requestDaemonProbe())
            .catch(() => {})
        })
      }
      if (!utils.isTauri()) {
        // Browser path: subscribe to browser MQTT state/error from the browser bridge
        const browserBridge = await import('@/lib/mqtt/mqtt-browser-bridge').catch(() => null)
        if (!browserBridge) return
        const { subscribeBrowserMqttState, subscribeBrowserMqttError } = browserBridge
        const setConnected = get().setConnected
        const setError = get().setError
        // mqtt.js auto-reconnect (reconnectPeriod) handles transient drops on
        // its own and resumes the persistent session. Only escalate to a full
        // credential refresh + client rebuild when the drop outlasts a grace
        // window — tearing down immediately would discard the broker-side
        // session (and its queued messages) on every blip.
        let disconnectedEscalation: ReturnType<typeof setTimeout> | null = null
        subscribeBrowserMqttState((state) => {
          setConnected(state === 'connected' ? true : state === 'disconnected' ? false : null)
          if (state === 'connected' || state === 'disconnected') {
            logMqttNetworkDiag('state', { connected: state === 'connected', transport: 'browser' })
          }
          if (state === 'connected' && disconnectedEscalation) {
            clearTimeout(disconnectedEscalation)
            disconnectedEscalation = null
          }
          if (state === 'disconnected' && !disconnectedEscalation) {
            disconnectedEscalation = setTimeout(() => {
              disconnectedEscalation = null
              if (get().connected !== true) {
                void recoverMqttCredentials(get, 'auto', 'visibility_resume')
              }
            }, BROWSER_RECONNECT_GRACE_MS)
          }
        })
        subscribeBrowserMqttError((message) => {
          setError(message)
          logMqttNetworkDiag('error', { message, transport: 'browser' })
          if (isMqttAuthFailure(message)) {
            void recoverMqttCredentials(get, 'auto', 'credential_rejected')
          }
        })
        return
      }
      const bridge = await import('@/lib/mqtt/mqtt-bridge').catch(() => null)
      if (!bridge) return
      const { mqttStatus } = bridge
      const { getDaemonMqttSnapshot } = await import('@/lib/daemon/daemon-local-client').catch(() => ({
        getDaemonMqttSnapshot: async () => null,
      }))
      const setConnected = get().setConnected
      const setError = get().setError
      const probe = async () => {
        const daemonSnapshot = await getDaemonMqttSnapshot()
        if (daemonSnapshot) {
          setConnected(daemonSnapshot.connected)
          return daemonSnapshot
        }
        try {
          const status = await mqttStatus()
          setConnected(status.connected)
        } catch {
          setConnected(false)
        }
        return null
      }
      const initialSnapshot = await probe()
      if (daemonMqttNeedsRecovery(initialSnapshot, get().connected)) {
        void recoverMqttCredentials(get, 'auto', 'startup')
      }
      try {
        const { listen } = await import('@tauri-apps/api/event')
        await listen<boolean>('mqtt:connected', (e) => {
          const connected = !!e.payload
          setConnected(connected)
          logMqttNetworkDiag('state', { connected, transport: 'tauri' })
        })
        await listen<string>('mqtt:error', (e) => {
          if (!e.payload) return
          const msg = String(e.payload)
          setError(msg)
          logMqttNetworkDiag('error', { message: msg, transport: 'tauri' })
          if (isMqttAuthFailure(msg)) {
            void recoverMqttCredentials(get, 'auto', 'credential_rejected')
          }
        })
        // Reconcile any change that landed while the listener was attaching.
        await probe()
      } catch {
        // Listening is best-effort; the initial probe value still stands.
      }
      // Slow self-heal: a missed event can never leave two indicators disagreeing.
      setInterval(probe, 20_000)

      // After laptop sleep the JWT may expire while timers are frozen; refresh
      // credentials only on suspected sleep/wake — tab switches just bump.
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            hiddenAtMs = Date.now()
            return
          }
          if (document.visibilityState !== 'visible') return
          void (async () => {
            const snapshot = await probe()
            if (!daemonMqttNeedsRecovery(snapshot, get().connected)) return

            const wasDiscarded =
              'wasDiscarded' in document &&
              (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true
            const hiddenMs = hiddenAtMs != null ? Date.now() - hiddenAtMs : 0
            hiddenAtMs = null

            if (shouldAutoRecoverMqttAfterVisibility({ wasDiscarded, hiddenMs })) {
              await recoverMqttCredentials(
                get,
                'auto',
                hiddenMs >= MQTT_SLEEP_WAKE_HIDDEN_MS || wasDiscarded
                  ? 'long_visibility_resume'
                  : 'visibility_resume',
              )
            } else {
              get().bump()
            }
          })()
        })
        window.addEventListener('focus', () => {
          void (async () => {
            const snapshot = await probe()
            if (daemonMqttNeedsRecovery(snapshot, get().connected)) {
              await recoverMqttCredentials(get, 'auto', 'visibility_resume')
            }
          })()
        })
      }
    })()
  },
}))

/** Test-only: reset module-level recovery throttle and store fields. */
export function __resetMqttReconnectForTests() {
  resetMqttReconnectRecovery()
}

/** Test-only: simulate a recent automatic recovery for cooldown assertions. */
export function __markAuthRecoveryForTests(atMs = Date.now()) {
  lastAuthRecoveryMs = atMs
}
