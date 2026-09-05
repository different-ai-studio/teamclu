import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEngagedAgentRuntimeMap } from '../use-engaged-agent-runtime-map'

/**
 * The hook is a pure derivation over the actor retain now. It used to fetch
 * `agent_runtimes` hints and runtime-targets from the cloud and reconcile them
 * with the retain, which is why these tests were async — there is nothing to
 * wait for any more.
 */
const mocks = vi.hoisted(() => ({
  byRuntimeId: {} as Record<string, unknown>,
}))

vi.mock('@/stores/runtime-state-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/runtime-state-store')>()
  return {
    ...actual,
    useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
      selector({ byRuntimeId: mocks.byRuntimeId }),
  }
})

/** A retain entry as the daemon publishes it, keyed by session id. */
function entry(daemonActorId: string, agentType: number, currentModel = '') {
  return {
    daemonActorId,
    lastUpdated: Date.now(),
    info: {
      runtimeId: '',
      agentType,
      currentModel,
      workspaceId: '',
      availableModels: [],
      availableCommands: [],
    },
  }
}

const OPENCODE = 2

describe('useEngagedAgentRuntimeMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.byRuntimeId = {}
  })

  it('maps the engaged agent to the attachment filed under the session id', () => {
    // The retain keys attachments by session because exactly one serves a
    // session at a time — that key IS the command address (ADR-0004).
    mocks.byRuntimeId = { 'a-1::displayed-session': entry('a-1', OPENCODE) }

    const { result } = renderHook(() =>
      useEngagedAgentRuntimeMap('displayed-session', ['a-1']),
    )

    expect(result.current.agentToRuntimeId.get('a-1')).toBe('displayed-session')
    expect(result.current.agentToBackendType.get('a-1')).toBe('pi')
  })

  it('does not leak another session\'s attachment', () => {
    // The old code had to reconcile a team-wide "latest runtime per agent" hint
    // against the session's own targets precisely because the hint could name a
    // different session's spawn. Keying by session removes the conflict.
    mocks.byRuntimeId = { 'a-1::other-session': entry('a-1', OPENCODE) }

    const { result } = renderHook(() =>
      useEngagedAgentRuntimeMap('displayed-session', ['a-1']),
    )

    expect(result.current.agentToRuntimeId.size).toBe(0)
  })

  it('reports nothing for a cold session', () => {
    // Absence is the signal: no entry means the next message spawns.
    const { result } = renderHook(() =>
      useEngagedAgentRuntimeMap('displayed-session', ['a-1']),
    )
    expect(result.current.agentToRuntimeId.size).toBe(0)
    expect(result.current.agentToBackendType.size).toBe(0)
  })

  it('clears maps when the engaged agent list becomes empty', () => {
    mocks.byRuntimeId = { 'a-1::session-1': entry('a-1', OPENCODE) }

    const { result, rerender } = renderHook(
      ({ sessionId, ids }: { sessionId: string | null; ids: string[] }) =>
        useEngagedAgentRuntimeMap(sessionId, ids),
      { initialProps: { sessionId: 'session-1' as string | null, ids: ['a-1'] } },
    )
    expect(result.current.agentToRuntimeId.get('a-1')).toBe('session-1')

    rerender({ sessionId: 'session-1', ids: [] })
    expect(result.current.agentToRuntimeId.size).toBe(0)
  })

  it('clears previous session bindings immediately on session switch', () => {
    // Synchronous now, so "immediately" is structural rather than a race the
    // old effect had to guard with a cancellation flag.
    mocks.byRuntimeId = { 'a-1::session-1': entry('a-1', OPENCODE) }

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useEngagedAgentRuntimeMap(sessionId, ['a-1']),
      { initialProps: { sessionId: 'session-1' } },
    )
    expect(result.current.agentToRuntimeId.get('a-1')).toBe('session-1')

    rerender({ sessionId: 'displayed-session' })
    expect(result.current.agentToRuntimeId.size).toBe(0)
  })
})
