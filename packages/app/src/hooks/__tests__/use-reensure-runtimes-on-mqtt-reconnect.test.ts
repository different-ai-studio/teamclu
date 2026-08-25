import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useReensureRuntimesOnMqttReconnect } from '../use-reensure-runtimes-on-mqtt-reconnect'
import type { EngagedAgentUiEntry } from '../use-engaged-agent-ui-states'
import { resetRuntimeEnsureThrottle, recordRuntimeEnsureAttempt } from '@/lib/teamclu/runtime-ensure-scheduler'

const ensureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mqttState = vi.hoisted(() => ({ connected: false as boolean | null }))

vi.mock('@/lib/teamclu/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: ensureMock,
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: (selector: (s: { connected: boolean | null }) => unknown) =>
    selector({ connected: mqttState.connected }),
}))

function entry(id: string, uiState: EngagedAgentUiEntry['uiState']): EngagedAgentUiEntry {
  return { agent: { id, displayName: id }, uiState, syncHint: null }
}

describe('useReensureRuntimesOnMqttReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeEnsureThrottle()
    mqttState.connected = false
  })

  it('re-ensures engaged agents when mqtt reconnects', () => {
    const { rerender } = renderHook(
      (props) => useReensureRuntimesOnMqttReconnect(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'offline')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    mqttState.connected = true
    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'offline')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'mqtt_reconnect_ensure',
      sessionRuntimeByAgent: undefined,
    })
  })

  it('re-ensures even when a recent runtime-start attempt was throttled', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])

    const { rerender } = renderHook(
      (props) => useReensureRuntimesOnMqttReconnect(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'offline')],
        },
      },
    )

    mqttState.connected = true
    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'offline')],
    })

    expect(ensureMock).toHaveBeenCalledTimes(1)
  })
})
