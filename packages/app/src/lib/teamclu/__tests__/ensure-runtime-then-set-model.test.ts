import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startAgentRuntimesAsync: vi.fn(),
  setModel: vi.fn(),
  waitForTeamcluRpcReady: vi.fn(),
  resolveAgentDevicePresence: vi.fn(),
  listParticipants: vi.fn(),
  addParticipant: vi.fn(),
  resolveSessionWorkspaceHintForRuntimeStart: vi.fn(),
  mqttConnected: true as boolean | null,
}))

vi.mock('@/lib/session/session-create', () => ({
  startAgentRuntimesAsync: (...args: unknown[]) => mocks.startAgentRuntimesAsync(...args),
}))

vi.mock('@/lib/daemon/teamclu-rpc', () => ({
  setModel: (...args: unknown[]) => mocks.setModel(...args),
  waitForTeamcluRpcReady: (...args: unknown[]) => mocks.waitForTeamcluRpcReady(...args),
}))

vi.mock('@/lib/agent/agent-device-reachability', () => ({
  resolveAgentDevicePresence: (...args: unknown[]) => mocks.resolveAgentDevicePresence(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: (...args: unknown[]) => mocks.listParticipants(...args),
      addParticipant: (...args: unknown[]) => mocks.addParticipant(...args),
    },
  }),
}))

vi.mock('@/lib/teamclu/resolve-runtime-start-workspace', () => ({
  resolveSessionWorkspaceHintForRuntimeStart: (...args: unknown[]) =>
    mocks.resolveSessionWorkspaceHintForRuntimeStart(...args),
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: {
    getState: () => ({ connected: mocks.mqttConnected }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/ws' }),
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

vi.mock('@/lib/i18n', () => ({
  default: {
    // Mirror i18next's two shapes: `t(key, fallback)` and `t(key, vars)`. The
    // naive fallback-only stub returned the options object itself, so any
    // message built from interpolated vars stringified to "[object Object]".
    t: (key: string, second?: string | Record<string, unknown>) => {
      if (typeof second === 'string' || second === undefined) return second ?? key
      const vars = second
      return Object.entries(vars).reduce<string>(
        (acc, [name, value]) => acc.replaceAll(`{{${name}}}`, String(value)),
        `${key} ${Object.keys(vars)
          .map((n) => `{{${n}}}`)
          .join(' ')}`,
      )
    },
  },
}))

describe('ensureRuntimeThenSetModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mqttConnected = true
    mocks.waitForTeamcluRpcReady.mockResolvedValue(true)
    mocks.resolveAgentDevicePresence.mockResolvedValue('online')
    mocks.listParticipants.mockResolvedValue([{ id: 'agent-1' }])
    mocks.resolveSessionWorkspaceHintForRuntimeStart.mockResolvedValue('ws-1')
    mocks.startAgentRuntimesAsync.mockResolvedValue({
      failures: [],
      runtimeIdsByAgent: { 'agent-1': 'spawn-live' },
    })
    mocks.setModel.mockResolvedValue({ success: true })
  })

  it('runtimeStarts then setModels with the daemon-returned spawn id', async () => {
    const { ensureRuntimeThenSetModel } = await import('@/lib/teamclu/ensure-agent-runtime')
    const result = await ensureRuntimeThenSetModel({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorId: 'agent-1',
      modelId: 'opencode/big-pickle',
    })

    expect(result).toEqual({ runtimeId: 'spawn-live' })
    expect(mocks.startAgentRuntimesAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorIds: ['agent-1'],
        modelId: 'opencode/big-pickle',
        skipModelApply: true,
      }),
    )
    expect(mocks.setModel).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      runtimeId: 'spawn-live',
      modelId: 'opencode/big-pickle',
      timeoutMs: expect.any(Number),
    })
  })

  it('throws when runtimeStart fails instead of guessing a stale spawn id', async () => {
    mocks.startAgentRuntimesAsync.mockResolvedValue({
      failures: [{ agentActorId: 'agent-1', code: 'runtime_rejected', reason: 'daemon busy' }],
      runtimeIdsByAgent: {},
    })

    const { ensureRuntimeThenSetModel } = await import('@/lib/teamclu/ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).rejects.toThrow('daemon busy')
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('aborts instead of starting a runtime the daemon could not read', async () => {
    // `sessions` is participant-only RLS. Starting anyway made the daemon report
    // "fetch_session_with_participants failed: not found: session not found",
    // which blames the session rather than this failed permission step.
    mocks.listParticipants.mockResolvedValue([])
    mocks.addParticipant.mockRejectedValue(new Error('row-level security violation'))

    const { ensureRuntimeThenSetModel } = await import('@/lib/teamclu/ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).rejects.toThrow(/row-level security violation/)

    expect(mocks.startAgentRuntimesAsync).not.toHaveBeenCalled()
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('still starts the runtime when the agent is already a participant', async () => {
    // addParticipant is skipped entirely in this case, so a previously-joined
    // agent must not be affected by the abort above.
    mocks.listParticipants.mockResolvedValue([{ id: 'agent-1' }])

    const { ensureRuntimeThenSetModel } = await import('@/lib/teamclu/ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).resolves.toEqual({ runtimeId: 'spawn-live' })
    expect(mocks.addParticipant).not.toHaveBeenCalled()
  })

  it('throws when mqtt is disconnected', async () => {
    mocks.mqttConnected = false
    const { ensureRuntimeThenSetModel } = await import('@/lib/teamclu/ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).rejects.toThrow('mqtt disconnected')
    expect(mocks.startAgentRuntimesAsync).not.toHaveBeenCalled()
  })
})
