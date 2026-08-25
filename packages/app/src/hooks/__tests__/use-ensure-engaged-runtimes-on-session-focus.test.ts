import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  hasConnectingEngagedAgent,
  hasRecoverableNonReadyAgent,
  useEnsureEngagedRuntimesOnSessionFocus,
} from '../use-ensure-engaged-runtimes-on-session-focus'
import type { EngagedAgentUiEntry } from '../use-engaged-agent-ui-states'
import { resetRuntimeEnsureThrottle } from '@/lib/teamclu/runtime-ensure-scheduler'

const ensureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/teamclu/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: ensureMock,
}))

function entry(id: string, uiState: EngagedAgentUiEntry['uiState']): EngagedAgentUiEntry {
  return { agent: { id, displayName: id }, uiState, syncHint: null }
}

describe('hasConnectingEngagedAgent / hasRecoverableNonReadyAgent', () => {
  it('hasConnectingEngagedAgent is true only for connecting pills', () => {
    expect(
      hasConnectingEngagedAgent([
        entry('a1', 'ready'),
        entry('a2', 'offline'),
      ]),
    ).toBe(false)
    expect(
      hasConnectingEngagedAgent([entry('a1', 'connecting')]),
    ).toBe(true)
  })

  it('hasRecoverableNonReadyAgent excludes LWT-offline agents', async () => {
    const { useActorPresenceStore } = await import('@/stores/actor-presence-store')
    useActorPresenceStore.setState({
      byActorId: { a1: { online: false, displayName: 'a', lastUpdated: 0 } },
    })
    expect(hasRecoverableNonReadyAgent([entry('a1', 'offline')])).toBe(false)

    useActorPresenceStore.setState({
      byActorId: { a1: { online: true, displayName: 'a', lastUpdated: 0 } },
    })
    expect(hasRecoverableNonReadyAgent([entry('a1', 'offline')])).toBe(true)

    useActorPresenceStore.setState({ byActorId: {} })
    expect(hasRecoverableNonReadyAgent([entry('a1', 'offline')])).toBe(true)
  })

  it('treats runtime startup failures as recoverable', () => {
    expect(hasRecoverableNonReadyAgent([entry('a1', 'runtime-error')])).toBe(true)
  })
})

describe('useEnsureEngagedRuntimesOnSessionFocus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeEnsureThrottle()
  })

  it('ensures non-ready agents when session focus changes', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'connecting')],
        },
      },
    )

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
      sessionRuntimeByAgent: undefined,
    })

    ensureMock.mockClear()
    resetRuntimeEnsureThrottle()

    rerender({
      sessionId: 'session-b',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'offline')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-b',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
      sessionRuntimeByAgent: undefined,
    })
  })

  it('ensures when an agent becomes connecting on the same session', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'ready')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'connecting')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_wake',
      sessionRuntimeByAgent: undefined,
    })
  })

  it('still wakes connecting when another session has a live spawn but this binding is stale', async () => {
    const { create } = await import('@bufbuild/protobuf')
    const { AgentStatus, RuntimeInfoSchema, RuntimeLifecycle } = await import('@/lib/proto/amux_pb')
    const { useRuntimeStateStore } = await import('@/stores/runtime-state-store')
    useRuntimeStateStore.getState().upsert(
      'rt-other',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-other',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'M' }],
      }),
    )

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'connecting')],
        agentToRuntimeId: new Map([['agent-1', 'rt-stale']]),
      }),
    )

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
      sessionRuntimeByAgent: expect.any(Map),
    })
    const call = ensureMock.mock.calls[0]?.[0] as {
      sessionRuntimeByAgent?: Map<string, string>
    }
    expect(call.sessionRuntimeByAgent?.get('agent-1')).toBe('rt-stale')

    useRuntimeStateStore.setState({ byRuntimeId: {} })
  })

  it('does not ensure when focus unchanged and all agents ready', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'ready')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'ready')],
    })

    expect(ensureMock).not.toHaveBeenCalled()
  })

  it('retries on an interval while agents stay connecting', () => {
    vi.useFakeTimers()

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'connecting')],
      }),
    )

    expect(ensureMock).toHaveBeenCalledTimes(1)
    ensureMock.mockClear()
    vi.advanceTimersByTime(3_100)

    vi.advanceTimersByTime(15_000)
    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_retry',
      sessionRuntimeByAgent: undefined,
    })

    vi.useRealTimers()
  })

  it('retries recoverable offline agents on an interval', () => {
    vi.useFakeTimers()

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'offline')],
      }),
    )

    expect(ensureMock).toHaveBeenCalledTimes(1)
    ensureMock.mockClear()
    vi.advanceTimersByTime(3_100)
    vi.advanceTimersByTime(15_000)
    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_retry',
      sessionRuntimeByAgent: undefined,
    })

    vi.useRealTimers()
  })

  it('retries runtime startup errors on an interval', () => {
    vi.useFakeTimers()

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'runtime-error')],
      }),
    )

    expect(ensureMock).toHaveBeenCalledTimes(1)
    ensureMock.mockClear()
    vi.advanceTimersByTime(3_100)
    vi.advanceTimersByTime(15_000)
    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_retry',
      sessionRuntimeByAgent: undefined,
    })

    vi.useRealTimers()
  })

  it('does not retry on an interval when agent is LWT-offline', async () => {
    vi.useFakeTimers()

    const { useActorPresenceStore } = await import('@/stores/actor-presence-store')
    useActorPresenceStore.setState({
      byActorId: { 'agent-1': { online: false, displayName: 'a', lastUpdated: 0 } },
    })

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'offline')],
      }),
    )

    expect(ensureMock).not.toHaveBeenCalled()
    ensureMock.mockClear()
    vi.advanceTimersByTime(15_000)
    expect(ensureMock).not.toHaveBeenCalled()

    useActorPresenceStore.setState({ byActorId: {} })
    vi.useRealTimers()
  })
})
