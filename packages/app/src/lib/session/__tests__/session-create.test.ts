import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentType } from '@/lib/proto/amux_pb'

const mockRuntimeStart = vi.fn().mockResolvedValue({
  accepted: true,
  runtimeId: 'rt-1',
  sessionId: 'sess-1',
  rejectedReason: '',
})
const mockSetModel = vi.fn().mockResolvedValue({})

const backendMocks = vi.hoisted(() => ({
  createSessionShell: vi.fn(),
  insertOutgoingMessage: vi.fn(),
  getSessionParticipants: vi.fn(),
  listAgentDefaults: vi.fn(),
  listActorDirectoryByIds: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
  createDaemonWorkspace: vi.fn(),
}))

const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '',
}))

const daemonAdminMocks = vi.hoisted(() => ({
  getLocalDaemonActorId: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: (...args: unknown[]) => daemonAdminMocks.getLocalDaemonActorId(...args),
}))

vi.mock('@/lib/daemon/teamclu-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: {
      createSessionShell: backendMocks.createSessionShell,
      getSessionParticipants: backendMocks.getSessionParticipants,
    },
    messages: {
      insertOutgoingMessage: backendMocks.insertOutgoingMessage,
    },
    runtime: {
      listAgentDefaults: backendMocks.listAgentDefaults,
    },
    actors: {
      listActorDirectoryByIds: backendMocks.listActorDirectoryByIds,
    },
    workspaces: {
      listDaemonWorkspaces: backendMocks.listDaemonWorkspaces,
      createDaemonWorkspace: backendMocks.createDaemonWorkspace,
    },
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: workspaceStoreMocks.workspacePath }),
  },
}))

vi.mock('@/lib/actor/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn().mockResolvedValue('member-1'),
}))

describe('startAgentRuntimesAsync', () => {
  beforeEach(() => {
    mockRuntimeStart.mockClear()
    mockSetModel.mockClear()
    backendMocks.createSessionShell.mockReset()
    backendMocks.insertOutgoingMessage.mockReset()
    backendMocks.getSessionParticipants.mockReset()
    backendMocks.listAgentDefaults.mockReset()
    backendMocks.listActorDirectoryByIds.mockReset()
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.createDaemonWorkspace.mockReset()
    daemonAdminMocks.getLocalDaemonActorId.mockReset()
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue(null)
    workspaceStoreMocks.workspacePath = ''
    backendMocks.createSessionShell.mockResolvedValue({ sessionId: 'sess-1' })
    backendMocks.insertOutgoingMessage.mockResolvedValue({})
    backendMocks.listActorDirectoryByIds.mockResolvedValue([])
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
    backendMocks.getSessionParticipants.mockResolvedValue([])
  })

  function mockTables(opts: {
    participants?: Array<{ agent_id: string; workspace_id: string | null }>
    actors?: Array<{ id: string; agent_types: string[]; default_agent_type: string | null; default_workspace_id?: string | null }>
    workspaces?: Array<{ id: string; agent_id: string | null; archived?: boolean }>
  }) {
    // The participant row owns this agent's workspace for this session
    // (ADR-0005). There is no team-wide runtime table to consult and no prior
    // spawn to inherit a backend type from — the agent type comes off the actor.
    backendMocks.getSessionParticipants.mockResolvedValue(
      (opts.participants ?? []).map((r) => ({
        actor_id: r.agent_id,
        workspaceId: r.workspace_id,
        model: null,
        lastProcessedMessageId: null,
      })),
    )
    backendMocks.listAgentDefaults.mockResolvedValue(opts.actors ?? [])
    backendMocks.listActorDirectoryByIds.mockResolvedValue(
      (opts.actors ?? []).map((a) => ({
        id: a.id,
        team_id: 'team-1',
        actor_type: 'agent',
        display_name: a.id,
        default_workspace_id: a.default_workspace_id ?? null,
        agent_types: a.agent_types,
        default_agent_type: a.default_agent_type,
      })),
    )
    backendMocks.listDaemonWorkspaces.mockResolvedValue(
      (opts.workspaces ?? []).map((w) => ({
        id: w.id,
        team_id: 'team-1',
        agent_id: w.agent_id,
        created_by_member_id: null,
        name: w.id,
        path: null,
        archived: w.archived ?? false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      })),
    )
  }

  it('returns the backend session id after creating a shell', async () => {
    backendMocks.createSessionShell.mockResolvedValueOnce({ sessionId: 'pb_session_1' })

    const { createSessionShell } = await import('@/lib/session/session-create')
    const result = await createSessionShell({
      teamId: 'team-1',
      creatorActorId: 'member-1',
      title: 'hello',
      additionalActorIds: ['agent-1'],
    })

    expect(result.sessionId).toBe('pb_session_1')
    expect(backendMocks.createSessionShell).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1',
      createdByActorId: 'member-1',
      additionalActorIds: ['agent-1'],
    }))
  })

  it('sends opencode runtimeStart requests for this-session runtime workspace', async () => {
    mockTables({
      participants: [{ agent_id: 'agent-1', workspace_id: 'ws-opencode' }],
      actors: [{ id: 'agent-1', agent_types: [], default_agent_type: 'opencode' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-1',
        workspaceId: 'ws-opencode',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('falls back to opencode runtimeStart requests without runtime history', async () => {
    mockTables({
      actors: [{ id: 'agent-2', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-2'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-2',
        workspaceId: '',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('uses the first supported agent type without runtime history', async () => {
    mockTables({
      actors: [{ id: 'agent-daemon', agent_types: ['opencode', 'claude'], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-daemon'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-daemon',
        workspaceId: '',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('prefers actor.default_agent_type over prior runtime backend_type', async () => {
    // Prior runtime was opencode, but the operator has since set the agent's
    // default_agent_type to cursor — the next spawn should respect that.
    mockTables({
      actors: [{ id: 'agent-3', agent_types: ['claude', 'cursor'], default_agent_type: 'cursor' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-3'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-3',
        agentType: AgentType.CURSOR,
      }),
    )
  })

  it('passes the selected model to runtimeStart', async () => {
    mockTables({
      actors: [{ id: 'agent-4', agent_types: [], default_agent_type: 'claude' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-4'],
      modelId: 'claude-opus-4-7',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-4',
        modelId: 'claude-opus-4-7',
      }),
    )
  })

  it('applies the selected model after runtimeStart accepts the runtime', async () => {
    mockTables({
      actors: [{ id: 'agent-6', agent_types: [], default_agent_type: 'opencode' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-6'],
      modelId: 'opencode/deepseek-v4-flash-free',
    })

    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-6',
      runtimeId: 'rt-1',
      modelId: 'opencode/deepseek-v4-flash-free',
      timeoutMs: 20_000,
    })
  })

  it('uses the selected backend instead of prior runtime backend_type', async () => {
    mockTables({
      actors: [{ id: 'agent-5', agent_types: [], default_agent_type: 'opencode' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-5'],
      agentType: AgentType.CLAUDE_CODE,
      modelId: 'claude-sonnet-4-6',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-5',
        agentType: AgentType.CLAUDE_CODE,
        modelId: 'claude-sonnet-4-6',
      }),
    )
  })

  it('creates a cloud workspace when the workspace lookup fails but the local path is known', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-7')
    backendMocks.getSessionParticipants.mockRejectedValue(new Error('participants unavailable'))
    backendMocks.listAgentDefaults.mockResolvedValue([
      { id: 'agent-7', agent_types: [], default_agent_type: null },
    ])
    workspaceStoreMocks.workspacePath = '/Users/me/TeamClu'
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-created',
      team_id: 'team-1',
      agent_id: 'agent-7',
      name: 'TeamClu',
      path: '/Users/me/TeamClu',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-7'],
    })

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        agentId: 'agent-7',
        path: '/Users/me/TeamClu',
      }),
    )
    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-7',
        workspaceId: 'ws-created',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('takes the workspace from the participant row, not the actor default', async () => {
    backendMocks.getSessionParticipants.mockResolvedValue([
      { actor_id: 'agent-8', workspaceId: 'ws-this-session', model: null, lastProcessedMessageId: null },
    ])
    backendMocks.listAgentDefaults.mockRejectedValue(new Error('agent defaults unavailable'))
    backendMocks.listActorDirectoryByIds.mockResolvedValue([
      { id: 'agent-8', team_id: 'team-1', actor_type: 'agent', display_name: 'agent-8',
        default_workspace_id: 'ws-actor-default', agent_types: [], default_agent_type: null },
    ])
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-8'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-8',
        workspaceId: 'ws-this-session',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('uses the selected local workspace path for the local daemon agent', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    workspaceStoreMocks.workspacePath = '/Users/me/copilot-ws-v2'
    mockTables({
      actors: [
        {
          id: 'agent-local',
          agent_types: [],
          default_agent_type: null,
          default_workspace_id: 'ws-accounting',
        },
      ],
      workspaces: [
        { id: 'ws-accounting', agent_id: 'agent-local' },
        { id: 'ws-copilot', agent_id: 'agent-local' },
      ],
    })
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-accounting',
        team_id: 'team-1',
        agent_id: 'agent-local',
        created_by_member_id: null,
        name: 'accounting-scripts',
        path: '/Users/me/accounting-scripts',
        archived: false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-local',
        created_by_member_id: null,
        name: 'copilot-ws-v2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      },
    ])

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-new',
      teamId: 'team-1',
      agentActorIds: ['agent-local'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-local',
        workspaceId: 'ws-copilot',
        // The local daemon also gets the path, so a workspace row without one
        // (every app's workspace) cannot silently spawn in the default folder.
        worktree: '/Users/me/copilot-ws-v2',
      }),
    )
  })

  it('uses agent default_workspace_id when runtime history is empty', async () => {
    mockTables({
      actors: [{ id: 'agent-9', agent_types: [], default_agent_type: null, default_workspace_id: 'ws-default' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-9'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-9',
        workspaceId: 'ws-default',
        worktree: '',
      }),
    )
  })

  it('prefers workspaceIdHint from send/outbox for the local daemon agent', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-10')
    mockTables({
      participants: [{ agent_id: 'agent-10', workspace_id: 'ws-session' }],
      actors: [{ id: 'agent-10', agent_types: [], default_agent_type: null, default_workspace_id: 'ws-default' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-10'],
      workspaceIdHint: 'ws-from-send',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-10',
        workspaceId: 'ws-from-send',
        worktree: '',
      }),
    )
  })

  it('ignores workspaceIdHint for remote agents and uses per-agent lookup', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('local-agent')
    mockTables({
      participants: [{ agent_id: 'remote-agent', workspace_id: 'ws-session' }],
      actors: [
        {
          id: 'remote-agent',
          agent_types: ['opencode'],
          default_agent_type: 'opencode',
          default_workspace_id: 'ws-remote-default',
        },
      ],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
      workspaceIdHint: 'ws-from-desktop-local',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'remote-agent',
        workspaceId: 'ws-session',
        worktree: '',
      }),
    )
  })

  it('applies workspaceIdHint only to the local daemon in a mixed batch', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('local-agent')
    mockTables({
      participants: [
        { agent_id: 'local-agent', workspace_id: 'ws-local-participant' },
        { agent_id: 'remote-agent', workspace_id: 'ws-remote-participant' },
      ],
      actors: [
        { id: 'local-agent', agent_types: ['opencode'], default_agent_type: 'opencode' },
        {
          id: 'remote-agent',
          agent_types: ['opencode'],
          default_agent_type: 'opencode',
          default_workspace_id: 'ws-remote-default',
        },
      ],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['local-agent', 'remote-agent'],
      workspaceIdHint: 'ws-from-desktop-local',
    })

    expect(mockRuntimeStart).toHaveBeenCalledTimes(2)
    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'local-agent',
        workspaceId: 'ws-from-desktop-local',
      }),
    )
    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'remote-agent',
        workspaceId: 'ws-remote-participant',
        worktree: '',
      }),
    )
  })

  it('sends the cloud workspace UUID straight to runtimeStart for the local daemon agent', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-12')
    mockTables({
      participants: [{ agent_id: 'agent-12', workspace_id: 'cloud-ws-1' }],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-12'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-12',
        workspaceId: 'cloud-ws-1',
        worktree: '',
      }),
    )
  })

  it('sends the cloud workspace id for remote agents without any daemon pre-registration', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('local-agent')
    mockTables({
      actors: [
        {
          id: 'remote-agent',
          agent_types: ['opencode'],
          default_agent_type: 'opencode',
          default_workspace_id: 'ws-remote',
        },
      ],
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'remote-agent',
        workspaceId: 'ws-remote',
        worktree: '',
      }),
    )
  })

  it('returns failures when runtimeStart is rejected', async () => {
    mockTables({
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockResolvedValueOnce({
      accepted: false,
      runtimeId: '',
      sessionId: 'sess-1',
      rejectedReason: 'daemon busy',
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    const { failures } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(failures).toEqual([
      { agentActorId: 'remote-agent', code: 'runtime_rejected', reason: 'daemon busy' },
    ])
  })

  it('returns failures when runtimeStart throws (e.g. RPC timeout)', async () => {
    mockTables({
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockRejectedValueOnce(new Error('RPC timeout'))

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    const { failures } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(failures).toEqual([
      { agentActorId: 'remote-agent', code: 'runtime_rpc_failed', reason: 'RPC timeout' },
    ])
  })

  it('returns accepted runtime ids and can skip post-start setModel', async () => {
    mockTables({
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockResolvedValueOnce({
      accepted: true,
      runtimeId: 'spawn-abc',
      sessionId: 'sess-1',
      rejectedReason: '',
    })

    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    const { failures, runtimeIdsByAgent } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
      modelId: 'opencode/big-pickle',
      skipModelApply: true,
    })

    expect(failures).toEqual([])
    expect(runtimeIdsByAgent).toEqual({ 'remote-agent': 'spawn-abc' })
    expect(mockSetModel).not.toHaveBeenCalled()
  })
})
