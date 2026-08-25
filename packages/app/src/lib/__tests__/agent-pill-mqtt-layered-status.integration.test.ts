/**
 * Integrated pipeline for agent-pill MQTT layered status.
 *
 * Exercises the same data path as draft-page idle without a live desktop:
 * daemon poll → debounced uiConnected → sidebar status + pill syncHint + suffix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { pillSuffixForAgentPill } from '@/components/chat/EngagedAgentOfflineBanner'
import {
  resolveLocalDaemonRuntimeStatus,
  type LocalDaemonHttpStatus,
} from '@/hooks/use-local-daemon-http-status'
import {
  resolveSessionAgentSyncHint,
  resolveSessionAgentUiState,
  type ReachabilityEvidence,
} from '@/lib/session-agent-ui-state'
import {
  subscribeDaemonMqttStatus,
  useDaemonMqttStatusStore,
  __resetDaemonMqttStatusForTests,
} from '@/stores/daemon-mqtt-status'

const getDaemonMqttConnected = vi.hoisted(() => vi.fn<() => Promise<boolean | null>>())

vi.mock('@/lib/daemon-agent-admin', () => ({ getDaemonMqttConnected }))
vi.mock('@/lib/agent-device-reachability', () => ({ noteLocalDaemonSignals: vi.fn() }))
vi.mock('@/lib/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'local-agent',
}))
vi.mock('@/lib/daemon-probe-signal', () => ({
  onDaemonProbeRequested: () => () => {},
}))

function evidence(status: ReachabilityEvidence['status']): ReachabilityEvidence {
  return {
    status,
    startedAt: 0,
    observedAt: 1,
    requestId: 1,
    contextKey: 'team:draft:draft:local-agent',
  }
}

function sidebarStatus(daemonMqttConnected: boolean | null): ReturnType<typeof resolveLocalDaemonRuntimeStatus> {
  return resolveLocalDaemonRuntimeStatus({
    daemonOnboardingReady: true,
    httpStatus: 'online' satisfies LocalDaemonHttpStatus,
    daemonMqttConnected,
  })
}

function pillSyncHint(
  uiState: 'ready' | 'connecting',
  daemonMqttConnected: boolean | null,
): ReturnType<typeof resolveSessionAgentSyncHint> {
  return resolveSessionAgentSyncHint({
    uiState,
    isLocalAgent: true,
    daemonMqttConnected,
    reachability: evidence('reachable'),
  })
}

const t = (_key: string, fallback?: string) => fallback ?? _key

describe('agent pill mqtt layered status — integrated pipeline', () => {
  describe('daemon mqtt poll debounce (store → sidebar + pill)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      getDaemonMqttConnected.mockReset()
      getDaemonMqttConnected.mockResolvedValue(true)
      __resetDaemonMqttStatusForTests()
    })

    afterEach(() => {
      __resetDaemonMqttStatusForTests()
      vi.useRealTimers()
    })

    it('matches the draft-idle repro: one transient false keeps sidebar and pill healthy', async () => {
      const release = subscribeDaemonMqttStatus()
      await vi.advanceTimersByTimeAsync(0)
      expect(sidebarStatus(useDaemonMqttStatusStore.getState().uiConnected)).toBe('online')
      expect(pillSyncHint('ready', useDaemonMqttStatusStore.getState().uiConnected)).toBeNull()
      expect(
        pillSuffixForAgentPill('ready', pillSyncHint('ready', useDaemonMqttStatusStore.getState().uiConnected), t),
      ).toBeNull()

      getDaemonMqttConnected.mockResolvedValue(false)
      await vi.advanceTimersByTimeAsync(20_000)

      const ui = useDaemonMqttStatusStore.getState().uiConnected
      expect(useDaemonMqttStatusStore.getState().connected).toBe(false)
      expect(ui).toBe(true)
      expect(sidebarStatus(ui)).toBe('online')
      expect(pillSyncHint('ready', ui)).toBeNull()
      expect(pillSuffixForAgentPill('ready', pillSyncHint('ready', ui), t)).toBeNull()

      getDaemonMqttConnected.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sidebarStatus(useDaemonMqttStatusStore.getState().uiConnected)).toBe('online')
      release()
    })

    it('alarms sidebar and pill together after sustained mqtt outage', async () => {
      getDaemonMqttConnected.mockResolvedValue(true)
      const release = subscribeDaemonMqttStatus()
      await vi.advanceTimersByTimeAsync(0)

      getDaemonMqttConnected.mockResolvedValue(false)
      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(20_000)

      const ui = useDaemonMqttStatusStore.getState().uiConnected
      expect(ui).toBe(false)
      expect(sidebarStatus(ui)).toBe('daemonMqttDisconnected')

      const hint = pillSyncHint('ready', ui)
      expect(hint).toBe('degraded')
      expect(pillSuffixForAgentPill('ready', hint, t)).toBe('Team sync interrupted')

      getDaemonMqttConnected.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sidebarStatus(useDaemonMqttStatusStore.getState().uiConnected)).toBe('online')
      expect(pillSyncHint('ready', useDaemonMqttStatusStore.getState().uiConnected)).toBeNull()
      release()
    })
  })

  describe('send layer stays ready on local draft/session mqtt blip', () => {
    const localLoopbackReady = {
      isLocalAgent: true,
      runtimeInfo: undefined,
      availableModelCount: 2,
      isStaleBinding: false,
      connectingTimedOut: true,
      reachability: evidence('reachable'),
      localCatalog: 'ready' as const,
    }

    it('keeps draft uiState ready when merged presence is unknown but loopback is up', () => {
      expect(resolveSessionAgentUiState({
        ...localLoopbackReady,
        context: { kind: 'draft' },
        presenceOnline: undefined,
      })).toBe('ready')
    })

    it('does not borrow runtime-error from connecting timeout on session mqtt blip', () => {
      expect(resolveSessionAgentUiState({
        ...localLoopbackReady,
        context: { kind: 'session', sessionId: 'session-1' },
        presenceOnline: false,
      })).toBe('ready')
    })

    it('still surfaces runtime-error when loopback sees FAILED', () => {
      expect(resolveSessionAgentUiState({
        ...localLoopbackReady,
        context: { kind: 'session', sessionId: 'session-1' },
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.FAILED } as never,
      })).toBe('runtime-error')
    })
  })
})
