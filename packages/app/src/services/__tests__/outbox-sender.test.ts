import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fromBinary } from '@bufbuild/protobuf'
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
} from '@/lib/proto/teamclu_pb'

const mocks = vi.hoisted(() => ({
  mqttPublish: vi.fn(),
  insertOutgoingMessage: vi.fn(),
  upsertOutbox: vi.fn(),
  deleteOutbox: vi.fn(),
  listAllOutbox: vi.fn(),
  maybeAutoTitleSessionFromFirstMessage: vi.fn().mockResolvedValue(true),
  isTauri: vi.fn(() => false),
  getLocalDaemonActorId: vi.fn(async () => null as string | null),
  ingestSessionLiveLocally: vi.fn(async () => undefined),
  runtimeStart: vi.fn(async () => ({})),
  getDaemonLocalAgent: vi.fn(async () => 'opencode' as const),
  cachedSessionWorkspaceForLocalDaemon: vi.fn(
    async () => null as { workspaceId: string; workspacePath: string } | null,
  ),
  bumpSessionListLastMessage: vi.fn(),
  markSessionViewed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/mqtt/mqtt-bridge', () => ({
  mqttPublish: mocks.mqttPublish,
}))

vi.mock('@/lib/session/session-auto-title', () => ({
  maybeAutoTitleSessionFromFirstMessage: mocks.maybeAutoTitleSessionFromFirstMessage,
}))

vi.mock('@/lib/session/session-list-preview', () => ({
  bumpSessionListLastMessage: mocks.bumpSessionListLastMessage,
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      markSessionViewed: mocks.markSessionViewed,
    }),
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => mocks.isTauri(),
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: () => mocks.getLocalDaemonActorId(),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  ingestSessionLiveLocally: (...args: unknown[]) => mocks.ingestSessionLiveLocally(...args),
  getDaemonLocalAgent: () => mocks.getDaemonLocalAgent(),
}))

vi.mock('@/lib/daemon/teamclu-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mocks.runtimeStart(...args),
}))

vi.mock('@/lib/backend', () => {
  class BackendError extends Error {
    category: string
    operation: string

    constructor(args: { category: string; operation: string; message: string }) {
      super(args.message)
      this.name = 'BackendError'
      this.category = args.category
      this.operation = args.operation
    }
  }

  return {
    BackendError,
    getBackend: () => ({
      messages: {
        insertOutgoingMessage: mocks.insertOutgoingMessage,
      },
      sessionMembers: {
        listParticipants: vi.fn().mockResolvedValue([
          { id: 'agent-1', actor_type: 'agent' },
          { id: 'agent-local', actor_type: 'agent' },
        ]),
      },
    }),
  }
})

vi.mock('@/lib/teamclu/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/teamclu/resolve-runtime-start-workspace', () => ({
  resolveSessionWorkspaceHintForRuntimeStart: vi.fn().mockResolvedValue(''),
  cachedSessionWorkspaceForLocalDaemon: (...args: unknown[]) =>
    mocks.cachedSessionWorkspaceForLocalDaemon(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/workspace' }),
  },
}))

vi.mock('@/lib/cache/local-cache', () => ({
  upsertOutbox: mocks.upsertOutbox,
  deleteOutbox: mocks.deleteOutbox,
  listAllOutbox: mocks.listAllOutbox,
}))

describe('outbox sender', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.mqttPublish.mockResolvedValue(undefined)
    mocks.insertOutgoingMessage.mockResolvedValue({})
    mocks.upsertOutbox.mockResolvedValue(undefined)
    mocks.deleteOutbox.mockResolvedValue(undefined)
    mocks.listAllOutbox.mockResolvedValue([])
    mocks.isTauri.mockReturnValue(false)
    mocks.getLocalDaemonActorId.mockResolvedValue(null)
    mocks.ingestSessionLiveLocally.mockResolvedValue(undefined)
    mocks.runtimeStart.mockResolvedValue({})
    mocks.getDaemonLocalAgent.mockResolvedValue('opencode')
    mocks.cachedSessionWorkspaceForLocalDaemon.mockResolvedValue(null)
  })

  afterEach(async () => {
    const { stopOutboxSender } = await import('../outbox-sender')
    stopOutboxSender()
  })

  it('publishes and persists the selected message model', async () => {
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    useOutboxStore.setState({
      byId: {
        'msg-1': {
          messageId: 'msg-1',
          teamId: 'team-1',
          sessionId: 'sess-1',
          senderActorId: 'member-1',
          content: 'hello daemon',
          model: 'opencode/qwen3.6-plus-free',
          mentionActorIds: ['agent-1'],
          displayMentionActorIds: ['agent-1'],
          attachmentUrls: [],
          workspaceIdHint: 'ws-from-enqueue',
          state: 'pending',
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.mqttPublish).toHaveBeenCalled()
    })

    expect(mocks.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1',
        teamId: 'team-1',
        sessionId: 'sess-1',
        senderActorId: 'member-1',
        content: 'hello daemon',
        model: 'opencode/qwen3.6-plus-free',
        metadata: expect.objectContaining({
          mention_actor_ids: ['agent-1'],
          display_mention_actor_ids: ['agent-1'],
        }),
      }),
    )
    expect(mocks.maybeAutoTitleSessionFromFirstMessage).toHaveBeenCalledWith(
      'sess-1',
      'hello daemon',
    )
    expect(mocks.bumpSessionListLastMessage).toHaveBeenCalledWith(
      'sess-1',
      'hello daemon',
      expect.objectContaining({ markUnread: false }),
    )
    expect(mocks.markSessionViewed).toHaveBeenCalledWith('sess-1', 'msg-1')

    const publishBytes = mocks.mqttPublish.mock.calls[0][1] as Uint8Array
    const live = fromBinary(LiveEventEnvelopeSchema, publishBytes)
    const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, live.body)
    expect(sessionMessage.message?.model).toBe('opencode/qwen3.6-plus-free')
    expect(sessionMessage.message?.content).toBe('hello daemon')
    expect(JSON.parse(sessionMessage.message?.metadataJson ?? '{}')).toMatchObject({
      mention_actor_ids: ['agent-1'],
      display_mention_actor_ids: ['agent-1'],
    })
    // Runtime ensure now runs after the live publish as a best-effort,
    // non-blocking cold-start, so wait for it rather than asserting synchronously.
    await vi.waitFor(() => {
      expect(ensureAgentRuntimesForSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          teamId: 'team-1',
          agentActorIds: ['agent-1'],
          workspaceIdHint: 'ws-from-enqueue',
          reason: 'outbox_send',
        }),
      )
    })
  })

  it('fans out to members even when the mentioned daemon runtime cannot be ensured', async () => {
    // Daemon offline / errored: ensuring its runtime rejects. Broadcasting the
    // human's message to OTHER members must NOT depend on that — otherwise an
    // offline daemon silently swallows real-time delivery to everyone else.
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
    vi.mocked(ensureAgentRuntimesForSession).mockRejectedValueOnce(
      new Error('daemon offline'),
    )

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-offline-daemon',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent are you there',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    // The live event must reach the session topic so other members see it.
    await vi.waitFor(() => {
      expect(mocks.mqttPublish).toHaveBeenCalled()
    })

    // And the message is considered delivered — an unreachable daemon does not
    // mark the human's message as failed/stuck.
    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-offline-daemon']
      expect(entry.state).toBe('delivered')
      expect(entry.lastError).toBeNull()
    })
  })

  it('publishes the live event before ensuring the agent runtime', async () => {
    const order: string[] = []
    mocks.mqttPublish.mockImplementation(async () => {
      order.push('publish')
    })
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
    vi.mocked(ensureAgentRuntimesForSession).mockImplementation(async () => {
      order.push('ensure')
    })

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-order',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hi',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(order).toContain('publish')
      expect(order).toContain('ensure')
    })
    expect(order.indexOf('publish')).toBeLessThan(order.indexOf('ensure'))
  })

  it('retries agent-mentioned messages when MQTT publish fails', async () => {
    mocks.mqttPublish.mockRejectedValue(new Error('mqtt not connected'))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-1',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hello',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-1']
      expect(entry.state).toBe('pending')
      expect(entry.attemptCount).toBe(1)
      expect(entry.lastError).toMatch(/mqtt not connected/)
    })
  })

  it('treats backend conflicts as already delivered messages', async () => {
    const { BackendError } = await import('@/lib/backend')
    mocks.insertOutgoingMessage.mockRejectedValueOnce(new BackendError({
      category: 'Conflict',
      operation: 'messages.insertOutgoingMessage',
      message: 'duplicate key',
    }))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-conflict',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: 'already persisted',
      model: null,
      mentionActorIds: [],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-conflict']
      expect(entry.state).toBe('delivered')
      expect(entry.lastError).toBeNull()
    })
    expect(mocks.mqttPublish).toHaveBeenCalled()
  })

  it('kickOutboxSender flushes a pending row without waiting for the interval', async () => {
    vi.useFakeTimers()
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender, kickOutboxSender } = await import('../outbox-sender')

    startOutboxSender()
    // Consume the immediate start tick so the next flush must come from kick.
    await vi.advanceTimersByTimeAsync(0)

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-kick',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: 'kick me',
      model: null,
      mentionActorIds: [],
      attachmentUrls: [],
    })

    expect(mocks.insertOutgoingMessage).not.toHaveBeenCalled()

    kickOutboxSender()
    await vi.advanceTimersByTimeAsync(0)

    await vi.waitFor(() => {
      expect(mocks.insertOutgoingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'msg-kick' }),
      )
    })

    // Interval has not fired yet (TICK_MS = 1000).
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  it('resolves workspaceIdHint during ensure when enqueue left it empty', async () => {
    const { resolveSessionWorkspaceHintForRuntimeStart } = await import(
      '@/lib/teamclu/resolve-runtime-start-workspace'
    )
    vi.mocked(resolveSessionWorkspaceHintForRuntimeStart).mockResolvedValueOnce('ws-from-outbox')

    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-no-hint',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hi',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
      workspaceIdHint: null,
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(ensureAgentRuntimesForSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceIdHint: 'ws-from-outbox',
          reason: 'outbox_send',
        }),
      )
    })
    expect(resolveSessionWorkspaceHintForRuntimeStart).toHaveBeenCalled()
  })

  it('local fast path carries a workspace id rather than an empty one', async () => {
    // It used to hardcode `workspaceId: ''`. The daemon skips its workspace
    // resolver for an empty id and starts in whatever `worktree` says, so the
    // slow path landing on a different directory ~0.8s later superseded this
    // runtime and respawned the backend — a 5.5s cold start paid twice on a
    // first message, by the very path that exists to be fast.
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockResolvedValue({})

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-ws-hint',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Local hi',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
      workspaceIdHint: 'ws-from-enqueue',
    })
    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.runtimeStart).toHaveBeenCalled()
    })
    expect(mocks.runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-from-enqueue' }),
    )
  })

  it("local fast path runs in the session's own workspace, not the agent's device default", async () => {
    // The device default belongs to the agent, not to one session. Sending the
    // first message in a just-created app started the runtime in whichever app
    // was open before it, so the agent edited that app's files and the new one
    // deployed as the untouched seed template.
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockResolvedValue({})
    mocks.cachedSessionWorkspaceForLocalDaemon.mockResolvedValue({
      workspaceId: 'ws-this-session',
      workspacePath: '/apps/this-session',
    })

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-session-ws',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Local hi',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
    })
    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.runtimeStart).toHaveBeenCalled()
    })
    expect(mocks.runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-this-session',
        // Not '/tmp/workspace' — the folder the desktop happens to have open.
        worktree: '/apps/this-session',
      }),
    )
  })

  it('local-only mentions: runtimeStart → ingest → MQTT → Cloud; Cloud failure still delivers', async () => {
    const order: string[] = []
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockImplementation(async () => {
      order.push('runtimeStart')
      return {}
    })
    mocks.ingestSessionLiveLocally.mockImplementation(async () => {
      order.push('ingest')
    })
    mocks.mqttPublish.mockImplementation(async () => {
      order.push('mqtt')
    })
    mocks.insertOutgoingMessage.mockImplementation(async () => {
      order.push('cloud')
      throw new Error('cloud down')
    })

    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-local-fast',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Local hi',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-local-fast']
      expect(entry?.state).toBe('delivered')
    })

    expect(order).toEqual(['runtimeStart', 'ingest', 'mqtt', 'cloud'])
    expect(mocks.runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-local',
        sessionId: 'session-1',
        worktree: '/tmp/workspace',
        // No enqueue hint and a cold cache in this fixture, so still empty —
        // the fast path degrades to the old behaviour rather than guessing.
        workspaceId: '',
        modelId: 'opencode/qwen',
      }),
    )
    expect(mocks.ingestSessionLiveLocally).toHaveBeenCalledWith(
      'session-1',
      expect.any(Uint8Array),
    )
    expect(ensureAgentRuntimesForSession).not.toHaveBeenCalled()
  })

  it('local fast path passes thread forkFrom to runtimeStart', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockResolvedValue({})

    const { rememberThreadForkMetadata, clearThreadForkMetadataForTests } =
      await import('@/lib/session/thread-fork-metadata')
    clearThreadForkMetadataForTests()
    rememberThreadForkMetadata('thread-session-1', 'parent-session-1', 'anchor-msg-1')

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-thread-fork',
      teamId: 'team-1',
      sessionId: 'thread-session-1',
      senderActorId: 'member-1',
      content: '@Local follow-up',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
    })
    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.runtimeStart).toHaveBeenCalled()
    })
    expect(mocks.runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'thread-session-1',
        forkFrom: {
          parentSessionId: 'parent-session-1',
          rootMessageId: 'anchor-msg-1',
        },
      }),
    )

    clearThreadForkMetadataForTests()
  })

  it('local-only mentions still deliver when the broker is down', async () => {
    // The whole point of the local fast path: the agent this message is
    // addressed to already has it (loopback ingest), so a dead broker must not
    // report a delivery that happened as one that did not — which left the
    // user staring at a failed bubble while the agent replied to it.
    // Contrast with the remote path, which legitimately retries on publish
    // failure ("retries agent-mentioned messages when MQTT publish fails").
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockResolvedValue({})
    mocks.ingestSessionLiveLocally.mockResolvedValue(undefined)
    mocks.mqttPublish.mockRejectedValue(new Error('mqtt not connected'))
    mocks.insertOutgoingMessage.mockResolvedValue(undefined)

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-local-no-broker',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Local hi',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-local-no-broker']
      expect(entry?.state).toBe('delivered')
    })

    // Delivery still reached the agent, and Cloud history still got written.
    expect(mocks.ingestSessionLiveLocally).toHaveBeenCalled()
    expect(mocks.insertOutgoingMessage).toHaveBeenCalled()
  })

  it('local delivery survives both the broker and Cloud being down', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    mocks.runtimeStart.mockResolvedValue({})
    mocks.ingestSessionLiveLocally.mockResolvedValue(undefined)
    mocks.mqttPublish.mockRejectedValue(new Error('mqtt not connected'))
    mocks.insertOutgoingMessage.mockRejectedValue(new Error('cloud down'))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-local-offline',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Local hi',
      model: 'opencode/qwen',
      mentionActorIds: ['agent-local'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-local-offline']
      expect(entry?.state).toBe('delivered')
    })
    expect(mocks.ingestSessionLiveLocally).toHaveBeenCalled()
  })

  it('isLocalOnlyAgentMention requires every mention to be the local daemon', async () => {
    const { isLocalOnlyAgentMention } = await import('../outbox-sender')
    expect(isLocalOnlyAgentMention(['agent-local'], 'agent-local')).toBe(true)
    expect(isLocalOnlyAgentMention(['agent-local', 'agent-remote'], 'agent-local')).toBe(false)
    expect(isLocalOnlyAgentMention([], 'agent-local')).toBe(false)
    expect(isLocalOnlyAgentMention(['agent-local'], null)).toBe(false)
  })
})
