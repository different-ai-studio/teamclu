import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentStatus,
  RuntimeInfoSchema,
  RuntimeLifecycle,
} from '@/lib/proto/amux_pb'
import {
  agentHasLiveRuntimeForSessionBinding,
  agentsHaveLiveRuntimeModels,
  isRuntimeEnsureWakeReason,
  recordRuntimeEnsureAttempt,
  resetRuntimeEnsureThrottle,
  runtimeEnsureKey,
  shouldSkipAlreadyReadyRuntimeEnsure,
  shouldSkipThrottledRuntimeEnsure,
  waitForWakeRuntimeRetain,
} from '@/lib/teamclu/runtime-ensure-scheduler'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'

describe('runtime-ensure-scheduler', () => {
  beforeEach(() => {
    resetRuntimeEnsureThrottle()
    useRuntimeStateStore.setState({ byRuntimeId: {} })
  })

  it('does not skip before any attempt is recorded', () => {
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('skips duplicate attempts within the throttle window', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(true)
  })

  it('does not skip a different session or agent set', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-b', ['agent-1'])).toBe(false)
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-2'])).toBe(false)
  })

  it('reset clears throttle state', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    resetRuntimeEnsureThrottle()
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('runtimeEnsureKey is stable regardless of agent order', () => {
    expect(runtimeEnsureKey('s', ['b', 'a'])).toBe(runtimeEnsureKey('s', ['a', 'b']))
  })

  it('classifies wake vs create/send reasons', () => {
    expect(isRuntimeEnsureWakeReason('session_focus')).toBe(true)
    expect(isRuntimeEnsureWakeReason('mqtt_reconnect_ensure')).toBe(true)
    expect(isRuntimeEnsureWakeReason('session_auto_engage')).toBe(true)
    expect(isRuntimeEnsureWakeReason('session_create')).toBe(false)
    expect(isRuntimeEnsureWakeReason('outbox_send')).toBe(false)
    expect(isRuntimeEnsureWakeReason('offline_banner_retry')).toBe(false)
    expect(isRuntimeEnsureWakeReason('mention_pill')).toBe(false)
  })

  it('skips wake ensures only when THIS session binding is ACTIVE with models', () => {
    useRuntimeStateStore.getState().upsert(
      'agent-1::rt-session',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-session',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'Model 1' }],
      }),
    )
    const map = new Map([['agent-1', 'rt-session']])
    expect(agentsHaveLiveRuntimeModels(['agent-1'], map)).toBe(true)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus', map)).toBe(true)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_create', map)).toBe(false)
  })

  it('skips wake ensures for actor-retain composite session keys (#711)', () => {
    useRuntimeStateStore.getState().upsert(
      'agent-1::session-a',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-a',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'Model 1' }],
      }),
    )
    const map = new Map([['agent-1', 'session-a']])
    expect(agentsHaveLiveRuntimeModels(['agent-1'], map)).toBe(true)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus', map)).toBe(true)
  })

  it('does not skip when session binding is missing even if another attachment is live', () => {
    useRuntimeStateStore.getState().upsert(
      'agent-1::rt-other-session',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-other-session',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'Model 1' }],
      }),
    )
    // Stale binding for this session — not present / not live in retain.
    const map = new Map([['agent-1', 'rt-stale']])
    expect(agentHasLiveRuntimeForSessionBinding('agent-1', 'rt-stale')).toBe(false)
    expect(agentsHaveLiveRuntimeModels(['agent-1'], map)).toBe(false)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus', map)).toBe(false)
  })

  it('does not skip wake ensures without a session binding map', () => {
    useRuntimeStateStore.getState().upsert(
      'rt-1',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-1',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'Model 1' }],
      }),
    )
    expect(agentsHaveLiveRuntimeModels(['agent-1'])).toBe(false)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus')).toBe(false)
  })

  it('does not skip wake ensures when session binding has no models', () => {
    useRuntimeStateStore.getState().upsert(
      'rt-1',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-1',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [],
      }),
    )
    const map = new Map([['agent-1', 'rt-1']])
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus', map)).toBe(false)
  })

  describe('waitForWakeRuntimeRetain', () => {
    it('returns ready immediately when session attachments are already live', async () => {
      useRuntimeStateStore.getState().upsert(
        'agent-1::session-a',
        'agent-1',
        create(RuntimeInfoSchema, {
          runtimeId: 'session-a',
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
          availableModels: [{ id: 'm1', displayName: 'Model 1' }],
        }),
      )
      const sleep = vi.fn(async () => {})
      await expect(
        waitForWakeRuntimeRetain({
          sessionId: 'session-a',
          agentActorIds: ['agent-1'],
          timeoutMs: 5_000,
          sleep,
        }),
      ).resolves.toEqual({ status: 'ready', stillNeeded: [] })
      expect(sleep).not.toHaveBeenCalled()
    })

    it('waits until retain arrives after a clear, then returns ready', async () => {
      let clock = 0
      const sleep = vi.fn(async (ms: number) => {
        clock += ms
        if (clock >= 200) {
          useRuntimeStateStore.getState().upsert(
            'agent-1::session-a',
            'agent-1',
            create(RuntimeInfoSchema, {
              runtimeId: 'session-a',
              state: RuntimeLifecycle.ACTIVE,
              status: AgentStatus.IDLE,
              availableModels: [{ id: 'm1', displayName: 'Model 1' }],
            }),
          )
        }
      })
      await expect(
        waitForWakeRuntimeRetain({
          sessionId: 'session-a',
          agentActorIds: ['agent-1'],
          timeoutMs: 5_000,
          pollMs: 100,
          now: () => clock,
          sleep,
        }),
      ).resolves.toEqual({ status: 'ready', stillNeeded: [] })
      expect(sleep.mock.calls.length).toBeGreaterThan(0)
    })

    it('returns timeout with stillNeeded when retain never arrives', async () => {
      let clock = 0
      const sleep = vi.fn(async (ms: number) => {
        clock += ms
      })
      await expect(
        waitForWakeRuntimeRetain({
          sessionId: 'session-a',
          agentActorIds: ['agent-1', 'agent-2'],
          timeoutMs: 300,
          pollMs: 100,
          now: () => clock,
          sleep,
        }),
      ).resolves.toEqual({
        status: 'timeout',
        stillNeeded: ['agent-1', 'agent-2'],
      })
    })

    it('on timeout only lists agents that are still missing retain', async () => {
      useRuntimeStateStore.getState().upsert(
        'agent-1::session-a',
        'agent-1',
        create(RuntimeInfoSchema, {
          runtimeId: 'session-a',
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
          availableModels: [{ id: 'm1', displayName: 'Model 1' }],
        }),
      )
      let clock = 0
      const sleep = vi.fn(async (ms: number) => {
        clock += ms
      })
      await expect(
        waitForWakeRuntimeRetain({
          sessionId: 'session-a',
          agentActorIds: ['agent-1', 'agent-2'],
          timeoutMs: 200,
          pollMs: 100,
          now: () => clock,
          sleep,
        }),
      ).resolves.toEqual({
        status: 'timeout',
        stillNeeded: ['agent-2'],
      })
    })
  })
})
