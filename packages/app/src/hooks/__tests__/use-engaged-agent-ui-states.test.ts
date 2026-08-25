import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  hasAnyNonReadyEngaged,
  useEngagedAgentUiStates,
} from '../use-engaged-agent-ui-states'

const mocks = vi.hoisted(() => ({
  byRuntimeId: {} as Record<string, { info: unknown }>,
  defaultCatalogByActorId: {} as Record<
    string,
    {
      defaultWorkspaceId: string
      defaultWorktree: string
      models: Array<{ id: string; displayName: string }>
      lastUpdated: number
    }
  >,
  presenceByActor: {} as Record<string, { online: boolean } | undefined>,
  probeResult: 'reachable' as 'reachable' | 'unreachable',
  localDaemonActorId: 'local-agent' as string | null,
  daemonMqttConnected: true as boolean | null,
}))

vi.mock('@/stores/runtime-state-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/runtime-state-store')>()
  return {
    ...actual,
    useRuntimeStateStore: (
      selector: (s: {
        byRuntimeId: typeof mocks.byRuntimeId
        defaultCatalogByActorId: typeof mocks.defaultCatalogByActorId
      }) => unknown,
    ) =>
      selector({
        byRuntimeId: mocks.byRuntimeId,
        defaultCatalogByActorId: mocks.defaultCatalogByActorId,
      }),
  }
})

vi.mock('@/stores/actor-presence-store', () => ({
  useActorPresenceStore: (selector: (s: { byActorId: typeof mocks.presenceByActor }) => unknown) =>
    selector({ byActorId: mocks.presenceByActor }),
}))

vi.mock('@/lib/agent-reachability-probe', () => ({
  probeAgentReachability: vi.fn(async () => mocks.probeResult),
}))

vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => mocks.localDaemonActorId),
}))

vi.mock('@/lib/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => mocks.localDaemonActorId,
  isSupersededLocalAgent: () => false,
  wasEverLocalDaemonIdentity: () => false,
  noteLocalDaemonActorId: vi.fn(),
}))

vi.mock('@/stores/daemon-mqtt-status', () => ({
  useDaemonMqttConnected: () => mocks.daemonMqttConnected,
}))

describe('hasAnyNonReadyEngaged', () => {
  it('returns true when any engaged agent is not ready', () => {
    expect(
      hasAnyNonReadyEngaged([
        { agent: { id: 'a', displayName: 'A' }, uiState: 'ready', syncHint: null },
        { agent: { id: 'b', displayName: 'B' }, uiState: 'offline', syncHint: null },
      ]),
    ).toBe(true)
  })

  it('returns false when all engaged agents are ready', () => {
    expect(
      hasAnyNonReadyEngaged([
        { agent: { id: 'a', displayName: 'A' }, uiState: 'ready', syncHint: null },
      ]),
    ).toBe(false)
  })
})

describe('useEngagedAgentUiStates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.byRuntimeId = {}
    mocks.defaultCatalogByActorId = {}
    mocks.presenceByActor = {}
    mocks.probeResult = 'reachable'
    mocks.localDaemonActorId = 'local-agent'
    mocks.daemonMqttConnected = true
  })

  it('marks agent offline when presence is false despite active runtime retain', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: false }
    mocks.byRuntimeId['remote-agent::rt-1'] = {
      daemonActorId: 'remote-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'MACPRO' }],
        new Map([['remote-agent', 'rt-1']]),
        new Set(),
        { kind: 'session', sessionId: 'rt-1' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('offline')
  })

  it('keeps a replying remote agent ready while live stream is active despite stale offline presence', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: false }
    mocks.byRuntimeId['remote-agent::rt-1'] = {
      daemonActorId: 'remote-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'b002-agent' }],
        new Map([['remote-agent', 'rt-1']]),
        new Set(['remote-agent']),
        { kind: 'session', sessionId: 'rt-1' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('ready')
  })

  it('keeps local active runtime ready after HTTP probe succeeds despite stale offline presence', async () => {
    mocks.presenceByActor['local-agent'] = { online: false }
    mocks.probeResult = 'reachable'
    mocks.byRuntimeId['local-agent::rt-1'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map([['local-agent', 'rt-1']]),
        new Set(),
        { kind: 'session', sessionId: 'rt-1' },
      ),
    )

    await waitFor(() => {
      expect(result.current[0]?.uiState).toBe('ready')
    }, { timeout: 3000 })
  })

  it('marks local ready agent offline when HTTP probe fails', async () => {
    mocks.presenceByActor['local-agent'] = { online: true }
    mocks.probeResult = 'unreachable'
    mocks.byRuntimeId['local-agent::rt-1'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map([['local-agent', 'rt-1']]),
        new Set(),
        { kind: 'session', sessionId: 'rt-1' },
      ),
    )

    await waitFor(() => {
      expect(result.current[0]?.uiState).toBe('offline')
    }, { timeout: 3000 })
  })

  it('stays connecting without a session binding even when another attachment is live', () => {
    mocks.presenceByActor['local-agent'] = { online: true }
    mocks.byRuntimeId['local-agent::rt-other'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-other',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map(),
        new Set(),
        { kind: 'session', sessionId: 'session-cold' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('connecting')
  })

  it('does not hop to another attachment when session binding retain is missing', () => {
    mocks.presenceByActor['local-agent'] = { online: true }
    mocks.byRuntimeId['local-agent::rt-other'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-other',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map([['local-agent', 'rt-new']]),
        new Set(),
        { kind: 'session', sessionId: 'rt-new' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('connecting')
  })

  it('resolves actor-retain attachment by composite key when multiple sessions are live', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }
    mocks.byRuntimeId = {
      'remote-agent::session-a': {
        daemonActorId: 'remote-agent',
        lastUpdated: Date.now(),
        info: {
          state: RuntimeLifecycle.ACTIVE,
          runtimeId: 'session-a',
          availableModels: [{ id: 'm1', displayName: 'Model' }],
        },
      },
      'remote-agent::session-b': {
        daemonActorId: 'remote-agent',
        lastUpdated: Date.now(),
        info: {
          state: RuntimeLifecycle.ACTIVE,
          runtimeId: 'session-b',
          availableModels: [{ id: 'm1', displayName: 'Model' }],
        },
      },
      'remote-agent::session-c': {
        daemonActorId: 'remote-agent',
        lastUpdated: Date.now(),
        info: {
          state: RuntimeLifecycle.ACTIVE,
          runtimeId: 'session-c',
          availableModels: [{ id: 'm1', displayName: 'Model' }],
        },
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'SPRBOT' }],
        new Map([['remote-agent', 'session-a']]),
        new Set(),
        { kind: 'session', sessionId: 'session-a' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('ready')
  })

  it('shows an online remote agent ready in a draft chat with no session binding', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }
    mocks.defaultCatalogByActorId['remote-agent'] = {
      defaultWorkspaceId: 'ws-default',
      defaultWorktree: '/tmp/default',
      models: [{ id: 'm1', displayName: 'Model' }],
      lastUpdated: Date.now(),
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'SPRBOT' }],
        new Map(),
        new Set(),
        { kind: 'draft' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('ready')
  })

  it('does not keep a remote draft connecting only because its machine advertises no models', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }
    mocks.byRuntimeId = {
      'remote-agent::other-session': {
        daemonActorId: 'remote-agent',
        lastUpdated: Date.now(),
        info: {
          state: RuntimeLifecycle.ACTIVE,
          runtimeId: 'other-session',
          availableModels: [],
        },
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'SPRBOT' }],
        new Map(),
        new Set(),
        { kind: 'draft' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('ready')
  })

  it('keeps an established cold session connecting even when the remote device is online', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'SPRBOT' }],
        new Map(),
        new Set(),
        { kind: 'session', sessionId: 'session-cold' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('connecting')
  })

  it('does not borrow another session ACTIVE attachment for a cold remote session', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }
    mocks.byRuntimeId['remote-agent::session-a'] = {
      daemonActorId: 'remote-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'session-a',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'SPRBOT' }],
        new Map(),
        new Set(),
        { kind: 'session', sessionId: 'session-b' },
      ),
    )

    expect(result.current[0]?.uiState).toBe('connecting')
  })

  it('keeps the timeout terminal state stable until fresh evidence arrives', async () => {
    vi.useFakeTimers()
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: true }

    try {
      const { result } = renderHook(() =>
        useEngagedAgentUiStates(
          [{ id: 'remote-agent', displayName: 'SPRBOT' }],
          new Map(),
          new Set(),
          { kind: 'session', sessionId: 'session-cold' },
        ),
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000)
      })
      expect(result.current[0]?.uiState).toBe('runtime-error')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(result.current[0]?.uiState).toBe('runtime-error')
    } finally {
      vi.useRealTimers()
    }
  })
})
