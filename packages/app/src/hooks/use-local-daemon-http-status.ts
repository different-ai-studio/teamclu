import * as React from 'react'
import { noteLocalDaemonSignals } from '@/lib/agent/agent-device-reachability'
import { probeDaemonHttp } from '@/lib/daemon/daemon-local-client'
import { onDaemonProbeRequested, requestDaemonProbe } from '@/lib/daemon/daemon-probe-signal'
import { QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS } from '@/lib/session/session-agent-probe'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useDaemonMqttConnected } from '@/stores/daemon-mqtt-status'

export type LocalDaemonHttpStatus = 'idle' | 'checking' | 'online' | 'offline'

/**
 * Shared probe state. One timer for the whole app, ref-counted by mounts —
 * mirroring `daemon-mqtt-status`, which already worked this way.
 *
 * Per-mount intervals meant N copies of the same probe against one local
 * daemon, all landing at slightly different times, and `requestDaemonProbe()`
 * fanned out to every one of them at once.
 */
let sharedStatus: LocalDaemonHttpStatus = 'idle'
const statusListeners = new Set<(s: LocalDaemonHttpStatus) => void>()
let probeSubscribers = 0
let probeTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeProbeSignal: (() => void) | null = null
let probeInFlight: Promise<void> | null = null
let onWindowFocus: (() => void) | null = null
let onVisibilityChange: (() => void) | null = null

function setSharedStatus(next: LocalDaemonHttpStatus) {
  if (sharedStatus === next) return
  sharedStatus = next
  statusListeners.forEach((fn) => fn(next))
}

function runSharedProbe(): Promise<void> {
  // Coalesce: a poll tick landing on top of a requestDaemonProbe() must not
  // produce two concurrent probes.
  probeInFlight ??= probeDaemonHttp()
    .then((probe) => setSharedStatus(probe.ok ? 'online' : 'offline'))
    .finally(() => {
      probeInFlight = null
    })
  return probeInFlight
}

function startSharedProbe() {
  setSharedStatus('checking')
  void runSharedProbe()
  probeTimer = setInterval(() => void runSharedProbe(), QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS)
  unsubscribeProbeSignal = onDaemonProbeRequested(() => void runSharedProbe())

  // A backgrounded desktop window can pause its interval, leaving the warning
  // stale after the daemon has already recovered. Re-probe as soon as the
  // window is usable again; requestDaemonProbe also refreshes the shared MQTT
  // status store, and runSharedProbe coalesces this with any in-flight poll.
  onWindowFocus = () => requestDaemonProbe()
  onVisibilityChange = () => {
    if (!document.hidden) requestDaemonProbe()
  }
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function stopSharedProbe() {
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
  unsubscribeProbeSignal?.()
  unsubscribeProbeSignal = null
  if (onWindowFocus) window.removeEventListener('focus', onWindowFocus)
  if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange)
  onWindowFocus = null
  onVisibilityChange = null
  setSharedStatus('idle')
}

export function useLocalDaemonHttpStatus(enabled = true): LocalDaemonHttpStatus {
  const daemonReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const [status, setStatus] = React.useState<LocalDaemonHttpStatus>(sharedStatus)

  React.useEffect(() => {
    if (!enabled || !daemonReady) {
      setStatus('idle')
      return
    }

    setStatus(sharedStatus)
    statusListeners.add(setStatus)
    probeSubscribers += 1
    if (probeSubscribers === 1) startSharedProbe()

    return () => {
      statusListeners.delete(setStatus)
      probeSubscribers -= 1
      if (probeSubscribers === 0) stopSharedProbe()
    }
  }, [daemonReady, enabled])

  return enabled && daemonReady ? status : 'idle'
}

export type LocalDaemonRuntimeStatus =
  | 'checking'
  | 'online'
  | 'offline'
  | 'daemonMqttDisconnected'

/**
 * The sidebar dot reports the **daemon's** two links and nothing else:
 *
 * - `offline` (red)                  — daemon itself unreachable
 * - `daemonMqttDisconnected` (amber) — daemon reachable, its MQTT link is down
 * - `online` (green)                 — daemon reachable and its MQTT link is up
 *
 * The desktop app's *own* MQTT connection deliberately does not feed in here —
 * it is a different fact about a different connection, and mixing the two into
 * one dot is what made this indicator disagree with the Daemon settings card
 * (#522). App-side MQTT is surfaced on the user account row instead.
 *
 * Both inputs come straight from the daemon over local HTTP (probe +
 * `/v1/info.mqtt_connected`), so MQTT presence retain — which can be stale or
 * ghosted — is not consulted either.
 */
export function resolveLocalDaemonRuntimeStatus(input: {
  daemonOnboardingReady: boolean
  httpStatus: LocalDaemonHttpStatus
  /** Daemon's own MQTT link from GET /v1/info. `null` = not known yet. */
  daemonMqttConnected: boolean | null
}): LocalDaemonRuntimeStatus {
  if (!input.daemonOnboardingReady) return 'offline'
  if (input.httpStatus === 'offline') return 'offline'
  if (input.httpStatus === 'checking' || input.httpStatus === 'idle') return 'checking'
  // HTTP reachable — the daemon is up; the only remaining question is its MQTT link.
  if (input.daemonMqttConnected === false) return 'daemonMqttDisconnected'
  if (input.daemonMqttConnected === true) return 'online'
  return 'checking'
}

/** Unified local-daemon status for the sidebar card (HTTP + MQTT + presence). */
export function useLocalDaemonRuntimeStatus(
  actorId: string | null,
  enabled = true,
): LocalDaemonRuntimeStatus {
  const daemonOnboardingReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const httpStatus = useLocalDaemonHttpStatus(enabled)
  const daemonMqttConnected = useDaemonMqttConnected(enabled && daemonOnboardingReady)

  // The daemon-MQTT half of the reachability cache is warmed by the shared poll
  // itself (`daemon-mqtt-status`); this only contributes the HTTP-probe half.
  React.useEffect(() => {
    if (!actorId) return
    noteLocalDaemonSignals({
      actorId,
      localHttpOk: httpStatus === 'online' ? true : httpStatus === 'offline' ? false : null,
    })
  }, [actorId, httpStatus])

  return resolveLocalDaemonRuntimeStatus({
    daemonOnboardingReady,
    httpStatus,
    daemonMqttConnected,
  })
}
