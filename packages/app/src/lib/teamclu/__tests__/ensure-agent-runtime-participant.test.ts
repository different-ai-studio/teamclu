import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startAgentRuntimesAsync: vi.fn(),
  resolveAgentDevicePresence: vi.fn(),
  listParticipants: vi.fn(),
  addParticipant: vi.fn(),
  resolveSessionWorkspaceHintForRuntimeStart: vi.fn(),
  waitForTeamcluRpcReady: vi.fn(),
  toastError: vi.fn(),
  reportRuntimeStartFailure: vi.fn(),
  recordRuntimeEnsureAttempt: vi.fn(),
}))

vi.mock('@/lib/session-create', () => ({
  startAgentRuntimesAsync: (...a: unknown[]) => mocks.startAgentRuntimesAsync(...a),
}))
vi.mock('@/lib/teamclu-rpc', () => ({
  setModel: vi.fn(),
  waitForTeamcluRpcReady: (...a: unknown[]) => mocks.waitForTeamcluRpcReady(...a),
}))
vi.mock('@/lib/agent-device-reachability', () => ({
  resolveAgentDevicePresence: (...a: unknown[]) => mocks.resolveAgentDevicePresence(...a),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: (...a: unknown[]) => mocks.listParticipants(...a),
      addParticipant: (...a: unknown[]) => mocks.addParticipant(...a),
    },
  }),
}))
vi.mock('@/lib/session-live-subscriptions', () => ({
  ensureSessionLiveSubscribed: vi.fn(async () => {}),
}))
vi.mock('@/lib/teamclu/resolve-runtime-start-workspace', () => ({
  resolveSessionWorkspaceHintForRuntimeStart: (...a: unknown[]) =>
    mocks.resolveSessionWorkspaceHintForRuntimeStart(...a),
}))
vi.mock('@/lib/teamclu/runtime-ensure-scheduler', () => ({
  recordRuntimeEnsureAttempt: (...a: unknown[]) => mocks.recordRuntimeEnsureAttempt(...a),
  isRuntimeEnsureWakeReason: () => false,
  shouldSkipAlreadyReadyRuntimeEnsure: () => false,
}))
vi.mock('@/lib/telemetry/runtime-error-report', async (importOriginal) => ({
  // Spread the real module so pure helpers the module under test calls
  // (`isCancelledRuntimeFailure`) keep working; only the reporters are stubbed.
  ...(await importOriginal<typeof import('@/lib/telemetry/runtime-error-report')>()),
  reportRuntimeEnsureCrash: vi.fn(),
  reportRuntimeRpcNotReady: vi.fn(),
  reportRuntimeStartFailure: (...a: unknown[]) => mocks.reportRuntimeStartFailure(...a),
}))
vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: { getState: () => ({ connected: true }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/tmp/ws' }) },
}))
vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: { getState: () => ({ byRuntimeId: {} }) },
}))
vi.mock('@/lib/runtime-state-resolve', () => ({
  // Non-empty so the post-start "wait for the retain" loop exits immediately;
  // otherwise every test that reaches runtimeStart burns its full 12s budget.
  resolveRuntimeStateEntryForAgent: () => ({
    info: { availableModels: [{ id: 'prov/model' }] },
  }),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => false }))
vi.mock('@/lib/i18n', () => ({
  default: { t: (key: string, second?: unknown) => (typeof second === 'string' ? second : key) },
}))
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => mocks.toastError(...a) } }))
vi.mock('@/stores/acp-debug-store', () => ({
  useAcpDebugStore: { getState: () => ({ append: vi.fn() }) },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ensureAgentRuntimesForSession — participant failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.waitForTeamcluRpcReady.mockResolvedValue(true)
    mocks.resolveAgentDevicePresence.mockResolvedValue('online')
    mocks.listParticipants.mockResolvedValue([])
    mocks.addParticipant.mockResolvedValue(undefined)
    mocks.resolveSessionWorkspaceHintForRuntimeStart.mockResolvedValue('ws-1')
    mocks.startAgentRuntimesAsync.mockResolvedValue({
      failures: [],
      runtimeIdsByAgent: {},
    })
  })

  it('drops an agent whose participant row could not be created', async () => {
    mocks.addParticipant.mockRejectedValue(new Error('rls denied'))

    const { ensureAgentRuntimesForSession } = await import('../ensure-agent-runtime')
    await ensureAgentRuntimesForSession({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
    })
    await flush()

    // Nothing may be started: the daemon could not read the session anyway, and
    // its "session not found" would blame the wrong thing.
    expect(mocks.startAgentRuntimesAsync).not.toHaveBeenCalled()
    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        agentActorId: 'agent-1',
        code: 'session_participant_failed',
        reason: 'rls denied',
      }),
      expect.anything(),
    )
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('starts the agents that did join and drops only the one that failed', async () => {
    mocks.addParticipant.mockImplementation(async (_sessionId: string, actorId: string) => {
      if (actorId === 'agent-bad') throw new Error('rls denied')
    })

    const { ensureAgentRuntimesForSession } = await import('../ensure-agent-runtime')
    await ensureAgentRuntimesForSession({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-ok', 'agent-bad'],
    })
    await flush()

    expect(mocks.startAgentRuntimesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agentActorIds: ['agent-ok'] }),
    )
    // The batch bookkeeping must not claim an attempt for the dropped agent.
    expect(mocks.recordRuntimeEnsureAttempt).toHaveBeenCalledWith('sess-1', ['agent-ok'])
  })

  it('starts every agent when all participant rows are in place', async () => {
    const { ensureAgentRuntimesForSession } = await import('../ensure-agent-runtime')
    await ensureAgentRuntimesForSession({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-1', 'agent-2'],
    })
    await flush()

    expect(mocks.startAgentRuntimesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agentActorIds: ['agent-1', 'agent-2'] }),
    )
    expect(mocks.reportRuntimeStartFailure).not.toHaveBeenCalled()
  })
})
