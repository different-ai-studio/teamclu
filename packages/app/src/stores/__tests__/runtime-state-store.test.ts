import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import {
  ActorPresenceSchema,
  LiveSessionSchema,
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
  WorktreeCatalogSchema,
} from '@/lib/proto/amux_pb'

const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const runtimeLeases: Array<{ release(): void }> = []

async function acquireRuntimeStateStoreForTest(teamId: string): Promise<void> {
  const { acquireRuntimeStateStore } = await import('../runtime-state-store')
  const lease = acquireRuntimeStateStore(teamId, `test-runtime-${runtimeLeases.length}`)
  runtimeLeases.push(lease)
  await lease.ready
}
const mockListen = vi.fn().mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
  envelopeHandler = handler
  return () => { envelopeHandler = null }
})

vi.mock('@/lib/mqtt/mqtt-bridge', () => ({
  mqttSubscribe: mockSubscribe,
  listenForEnvelopes: mockListen,
  mqttPublish: vi.fn(),
}))

beforeEach(() => {
  mockSubscribe.mockClear()
  mockSubscribe.mockResolvedValue(undefined)
  mockListen.mockClear()
  mockListen.mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
    envelopeHandler = handler
    return () => { envelopeHandler = null }
  })
  envelopeHandler = null
})

function flushRuntimeStateBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  for (let index = runtimeLeases.length - 1; index >= 0; index -= 1) {
    runtimeLeases[index].release()
  }
  runtimeLeases.length = 0
})

describe('runtime-state-store', () => {
  it('subscribes only to the actor state wildcard for the team', async () => {
    await acquireRuntimeStateStoreForTest('team-1')
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/state')
  })

  it('registers the envelope handler before subscribing (boot retain race)', async () => {
    const callOrder: string[] = []
    mockListen.mockImplementation(async (handler) => {
      callOrder.push('listen')
      envelopeHandler = handler
      return () => {
        envelopeHandler = null
      }
    })
    mockSubscribe.mockImplementation(async () => {
      callOrder.push('subscribe')
      // mqtt.js can deliver retained messages before SUBACK resolves.
      envelopeHandler?.({
        topic: 'amux/team-1/dev-a/state',
        bytes: Array.from(
          toBinary(
            ActorPresenceSchema,
            create(ActorPresenceSchema, {
              online: true,
              defaultWorktree: '/tmp/default',
              defaultWorkspaceModels: [{ id: 'shopee/gpt-5.5', displayName: 'gpt-5.5' }],
            }),
          ),
        ),
      })
    })

    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')
    await flushRuntimeStateBatch()

    expect(callOrder).toEqual(['listen', 'subscribe'])
    expect(useRuntimeStateStore.getState().defaultCatalogByActorId['dev-a']?.models).toHaveLength(1)
  })

  it('decodes ActorPresence retained messages and upserts composite keys', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    const presence = create(ActorPresenceSchema, {
      online: true,
      catalogModels: [{ id: 'opencode/mimo', displayName: 'Mimo' }],
      worktrees: [
        create(WorktreeCatalogSchema, {
          worktree: '/tmp/x',
          modelIndices: [0],
          defaultModel: 'opencode/mimo',
        }),
      ],
      liveSessions: [
        create(LiveSessionSchema, {
          sessionId: 'session-1',
          currentModel: 'opencode/mimo',
          lifecycle: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
          worktree: '/tmp/x',
        }),
      ],
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    const entry = useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']
    expect(entry).toBeTruthy()
    expect(entry.daemonActorId).toBe('dev-a')
    expect(entry.info.runtimeId).toBe('session-1')
    expect(entry.info.currentModel).toBe('opencode/mimo')
  })

  it('stores default workspace catalog from ActorPresence', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    const presence = create(ActorPresenceSchema, {
      online: true,
      defaultWorkspaceId: 'ws-default',
      defaultWorktree: '/tmp/default',
      defaultWorkspaceModels: [{ id: 'shopee/gpt-5.5', displayName: 'gpt-5.5' }],
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    const entry = useRuntimeStateStore.getState().defaultCatalogByActorId['dev-a']
    expect(entry?.defaultWorkspaceId).toBe('ws-default')
    expect(entry?.defaultWorktree).toBe('/tmp/default')
    expect(entry?.models.map((m) => m.id)).toEqual(['shopee/gpt-5.5'])
  })

  it('ignores legacy per-runtime topics', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'rt-1',
      agentType: AgentType.CLAUDE_CODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/runtime/rt-1/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })
    await flushRuntimeStateBatch()

    expect(Object.keys(useRuntimeStateStore.getState().byRuntimeId)).toHaveLength(0)
  })

  it('ignores envelopes with malformed topics', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })
    envelopeHandler!({ topic: 'unrelated', bytes: [1] })
    await flushRuntimeStateBatch()

    expect(Object.keys(useRuntimeStateStore.getState().byRuntimeId)).toHaveLength(0)
  })

  it('ignores envelopes for other teams', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    const presence = create(ActorPresenceSchema, {
      liveSessions: [create(LiveSessionSchema, { sessionId: 'session-other', worktree: '/tmp/x' })],
    })
    envelopeHandler!({
      topic: 'amux/team-2/dev-x/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    expect(useRuntimeStateStore.getState().byRuntimeId['dev-x::session-other']).toBeUndefined()
  })

  it('batches actor state bursts into one store notification', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    let notifications = 0
    const unsubscribe = useRuntimeStateStore.subscribe(() => {
      notifications += 1
    })

    const presence = create(ActorPresenceSchema, {
      liveSessions: [
        create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/w' }),
        create(LiveSessionSchema, { sessionId: 'session-2', worktree: '/w' }),
      ],
    })

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()
    unsubscribe()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['dev-a::session-1']).toBeTruthy()
    expect(store['dev-a::session-2']).toBeTruthy()
    expect(notifications).toBe(1)
  })

  it('batches an actor-state burst delivered as separate mqtt:envelopes emits into one notification', async () => {
    // TEAMCLU-REACT-72/85/7N: a reconnect retain flood is not guaranteed to
    // arrive as a single `mqtt:envelopes` batch — Tauri can emit it as several
    // back-to-back events, each its own macrotask. `queueMicrotask` only
    // coalesces updates within the SAME synchronous callback, so a second
    // emit landing on its own macrotask used to slip past an already-flushed
    // microtask and trigger its own extra `set()` — one more React commit per
    // emit, tight enough to blow React's nested-update limit. The `setTimeout`
    // flush must instead pick up any emit that lands before it fires,
    // regardless of which macrotask it arrived on.
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    let notifications = 0
    const unsubscribe = useRuntimeStateStore.subscribe(() => {
      notifications += 1
    })

    const presenceA = create(ActorPresenceSchema, {
      liveSessions: [create(LiveSessionSchema, { sessionId: 'session-a', worktree: '/w' })],
    })
    const presenceB = create(ActorPresenceSchema, {
      liveSessions: [create(LiveSessionSchema, { sessionId: 'session-b', worktree: '/w' })],
    })

    // Registered first, so it lands in the macrotask queue ahead of the flush
    // timer that the first envelope below schedules — simulating a second,
    // separate `mqtt:envelopes` emit that arrives before the pending flush.
    setTimeout(() => {
      envelopeHandler!({
        topic: 'amux/team-1/dev-b/state',
        bytes: Array.from(toBinary(ActorPresenceSchema, presenceB)),
      })
    }, 0)

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presenceA)),
    })

    await new Promise((r) => setTimeout(r, 20))
    unsubscribe()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['dev-a::session-a']).toBeTruthy()
    expect(store['dev-b::session-b']).toBeTruthy()
    expect(notifications).toBe(1)
  })

  it('upsert preserves entries under distinct composite keys', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-a',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-a',
        currentModel: 'mimo',
        availableModels: [{ id: 'mimo', displayName: 'Mimo' }],
      }),
    )

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-b',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-b',
        currentModel: 'big-pickle',
        availableModels: [{ id: 'big-pickle', displayName: 'Big Pickle' }],
      }),
    )

    const map = useRuntimeStateStore.getState().byRuntimeId
    expect(map['agent-uuid::session-a']?.info.currentModel).toBe('mimo')
    expect(map['agent-uuid::session-b']?.info.currentModel).toBe('big-pickle')
    expect(map['agent-uuid']).toBeUndefined()
  })

  it('upsert no longer reaches into pick-store (no circular dependency)', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    const { useAgentModelPickStore } = await import('../agent-model-pick-store')
    useAgentModelPickStore.getState().setPick('s-1', 'agent-uuid', 'mimo')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'session-1',
      currentModel: 'big-pickle',
      availableModels: [
        { id: 'big-pickle', displayName: 'Big Pickle' },
        { id: 'mimo', displayName: 'Mimo' },
      ],
    })
    useRuntimeStateStore.getState().upsert('agent-uuid::session-1', 'agent-uuid', info)

    expect(useRuntimeStateStore.getState().byRuntimeId['agent-uuid::session-1'].info.currentModel).toBe(
      'big-pickle',
    )
  })

  it('prunes detached sessions when live_sessions shrinks', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
              create(LiveSessionSchema, { sessionId: 'session-2', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()

    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeTruthy()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-2']).toBeTruthy()

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['dev-a::session-1']).toBeTruthy()
    expect(store['dev-a::session-2']).toBeUndefined()
  })

  it('clears all actor attachments when live_sessions is empty', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    await acquireRuntimeStateStoreForTest('team-1')

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeTruthy()

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, { liveSessions: [] }),
        ),
      ),
    })
    await flushRuntimeStateBatch()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeUndefined()
  })

  it('preserves catalog when a partial retain arrives without available_models', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-1',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-1',
        state: RuntimeLifecycle.ACTIVE,
        availableModels: [{ id: 'mimo', displayName: 'Mimo' }],
      }),
    )

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-1',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-1',
        state: RuntimeLifecycle.ACTIVE,
        availableModels: [],
      }),
    )

    expect(
      useRuntimeStateStore.getState().byRuntimeId['agent-uuid::session-1']?.info.availableModels,
    ).toHaveLength(1)
  })
})
