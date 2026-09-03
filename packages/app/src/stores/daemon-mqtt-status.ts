import * as React from 'react'
import { create } from 'zustand'
import { noteLocalDaemonSignals } from '@/lib/agent/agent-device-reachability'
import { getDaemonMqttConnected } from '@/lib/daemon/daemon-agent-admin'
import { onDaemonProbeRequested } from '@/lib/daemon/daemon-probe-signal'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS } from '@/lib/session/session-agent-probe'

const DAEMON_MQTT_STARTUP_SETTLE_MS = 15_000
const DAEMON_MQTT_STARTUP_RETRY_MS = 1_000

/** Consecutive raw false polls before UI surfaces a disconnect (sidebar, pill). */
const DAEMON_MQTT_UI_FALSE_STREAK_REQUIRED = 2

type DaemonMqttStatusState = {
  /** Latest raw reading from `GET /v1/info`. `null` = unknown / daemon unreachable. */
  connected: boolean | null
  /** Debounced reading for UI — filters transient rebuild windows. */
  uiConnected: boolean | null
  falseStreak: number
  setConnected: (connected: boolean | null) => void
  refresh: () => Promise<void>
}

/**
 * Shared daemon-MQTT state, polled exactly once for the whole app.
 *
 * Both the sidebar status dot and the Daemon settings MQTT card read this. They
 * used to each run their own `getDaemonMqttConnected()` interval, so the two
 * views could disagree for up to a full poll period purely from timer skew —
 * which read to users as "the two places don't match" (#522).
 */
export const useDaemonMqttStatusStore = create<DaemonMqttStatusState>((set) => ({
  connected: null,
  uiConnected: null,
  falseStreak: 0,
  setConnected: (connected) => set({ connected }),
  refresh: async () => {
    const connected = await getDaemonMqttConnected()
    publishMqttStatus(connected)
  },
}))

let subscriberCount = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let startupRetryTimer: ReturnType<typeof setTimeout> | null = null
let startupSettling = false
let startupDeadline = 0
let pollingGeneration = 0
let unsubscribeProbe: (() => void) | null = null

function nextUiConnected(
  raw: boolean | null,
  prevUi: boolean | null,
  prevStreak: number,
): { uiConnected: boolean | null; falseStreak: number } {
  if (raw === true) {
    return { uiConnected: true, falseStreak: 0 }
  }
  if (raw === false) {
    const falseStreak = prevStreak + 1
    if (falseStreak >= DAEMON_MQTT_UI_FALSE_STREAK_REQUIRED) {
      return { uiConnected: false, falseStreak }
    }
    return { uiConnected: prevUi, falseStreak }
  }
  return { uiConnected: null, falseStreak: 0 }
}

function publishMqttStatus(connected: boolean | null): void {
  const prev = useDaemonMqttStatusStore.getState()
  const { uiConnected, falseStreak } = nextUiConnected(
    connected,
    prev.uiConnected,
    prev.falseStreak,
  )
  useDaemonMqttStatusStore.setState({ connected, uiConnected, falseStreak })
  // Warm the short-TTL device-reachability cache on every tick, not only when
  // the value flips — the runtime-start gate reads it synchronously and a
  // change-only write would leave it permanently expired. Always the raw poll.
  const actorId = getKnownLocalDaemonActorId()
  if (actorId) noteLocalDaemonSignals({ actorId, daemonMqttConnected: connected })
}

async function pollDuringStartup(generation: number): Promise<void> {
  const connected = await getDaemonMqttConnected()
  if (generation !== pollingGeneration) return
  if (startupSettling && connected !== true && Date.now() < startupDeadline) {
    // HTTP becomes ready before the daemon finishes its first MQTT CONNACK.
    // Keep the UI in "checking" and retry quickly instead of showing a real
    // disconnect that disappears as soon as the user clicks the banner.
    if (!startupRetryTimer) {
      startupRetryTimer = setTimeout(() => {
        startupRetryTimer = null
        void pollDuringStartup(generation)
      }, DAEMON_MQTT_STARTUP_RETRY_MS)
    }
    return
  }

  startupSettling = false
  publishMqttStatus(connected)
}

function startPolling() {
  const generation = ++pollingGeneration
  startupSettling = true
  startupDeadline = Date.now() + DAEMON_MQTT_STARTUP_SETTLE_MS
  const poll = () => {
    if (startupSettling) {
      void pollDuringStartup(generation)
    } else {
      void useDaemonMqttStatusStore.getState().refresh()
    }
  }
  poll()
  pollTimer = setInterval(poll, QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS)
  // Retry / network-online should not have to wait out the poll interval.
  unsubscribeProbe = onDaemonProbeRequested(() => poll())
}

function stopPolling() {
  pollingGeneration += 1
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (startupRetryTimer) clearTimeout(startupRetryTimer)
  startupRetryTimer = null
  startupSettling = false
  startupDeadline = 0
  unsubscribeProbe?.()
  unsubscribeProbe = null
  useDaemonMqttStatusStore.setState({ connected: null, uiConnected: null, falseStreak: 0 })
}

/**
 * Ref-counted subscription to the shared poll. The interval runs while at least
 * one mounted consumer wants it and is torn down once the last one leaves.
 */
export function subscribeDaemonMqttStatus(): () => void {
  subscriberCount += 1
  if (subscriberCount === 1) startPolling()
  let released = false
  return () => {
    if (released) return
    released = true
    subscriberCount -= 1
    if (subscriberCount === 0) stopPolling()
  }
}

/**
 * Daemon's own MQTT connection state for UI (sidebar, settings, pill sync hint).
 * Pass `enabled: false` while the daemon is not expected to be up (onboarding
 * incomplete) to avoid pointless polling.
 *
 * Returns a debounced value: one transient false poll does not flip UI to
 * disconnected. Runtime gates still read the raw poll via `noteLocalDaemonSignals`.
 */
export function useDaemonMqttConnected(enabled = true): boolean | null {
  const uiConnected = useDaemonMqttStatusStore((s) => s.uiConnected)
  React.useEffect(() => {
    if (!enabled) return
    return subscribeDaemonMqttStatus()
  }, [enabled])
  return enabled ? uiConnected : null
}

/** @internal test helper */
export function __resetDaemonMqttStatusForTests(): void {
  stopPolling()
  subscriberCount = 0
}
