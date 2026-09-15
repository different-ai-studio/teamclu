import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendMocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn().mockResolvedValue([]),
  createDaemonWorkspace: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    workspaces: {
      listDaemonWorkspaces: backendMocks.listDaemonWorkspaces,
      createDaemonWorkspace: backendMocks.createDaemonWorkspace,
    },
    runtime: {
      fetchLatestRuntimeForSession: vi.fn(),
    },
    actors: {
      listActorDirectoryByIds: vi.fn().mockResolvedValue([]),
    },
    sessions: {
      getSessionParticipants: vi.fn().mockResolvedValue([]),
    },
  }),
}))

import {
  resolveAgentRuntimeWorkspaceId,
  resolveCloudWorkspaceIdForLocalPath,
  resolveSessionWorkspaceHintForRuntimeStart,
  ensureCloudWorkspaceIdForAgentRuntime,
  runtimeStartWorkspaceArgs,
} from '@/lib/teamclu/resolve-runtime-start-workspace'
import { useAgentDefaultWorkspaceStore } from '@/stores/agent-default-workspace-store'

describe('resolveAgentRuntimeWorkspaceId', () => {
  it('prefers caller hint over session runtime and defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        callerWorkspaceId: 'ws-caller',
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-caller')
  })

  it('prefers this-session runtime workspace over defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-session')
  })

  it('falls back to default_workspace_id then agent-bound workspace', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-default')

    expect(
      resolveAgentRuntimeWorkspaceId({
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-owned')
  })

  it('returns empty when no cloud workspace is known', () => {
    expect(resolveAgentRuntimeWorkspaceId({})).toBe('')
  })
})

describe('runtimeStartWorkspaceArgs', () => {
  it('sends no worktree by default', () => {
    expect(runtimeStartWorkspaceArgs('uuid-ws')).toEqual({
      workspaceId: 'uuid-ws',
      worktree: '',
    })
  })

  it('passes a local worktree through for the daemon on this machine', () => {
    // An app's cloud workspace row has no path, so without this the daemon
    // spawns in the onboarded default workspace instead of the app checkout.
    expect(runtimeStartWorkspaceArgs('uuid-ws', '/Users/me/.amuxd/apps/app-1')).toEqual({
      workspaceId: 'uuid-ws',
      worktree: '/Users/me/.amuxd/apps/app-1',
    })
  })

  it('trims and tolerates a blank worktree', () => {
    expect(runtimeStartWorkspaceArgs('uuid-ws', '   ').worktree).toBe('')
    expect(runtimeStartWorkspaceArgs('uuid-ws', ' /tmp/ws ').worktree).toBe('/tmp/ws')
  })
})

describe('resolveCloudWorkspaceIdForLocalPath', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('matches cloud workspace when API returns legacy slug field', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-cloud',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'Main',
        path: '/Users/me/TeamClu',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveCloudWorkspaceIdForLocalPath('team-1', '~/TeamClu', { agentActorId: 'agent-1' }),
    ).resolves.toBe('ws-cloud')
  })

  it('ignores teammate workspaces that share the same folder name', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-teammate',
        team_id: 'team-1',
        agent_id: 'agent-a',
        name: 'TeamClu',
        path: '/Users/matt.chow/TeamClu',
        archived: false,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'ws-local',
        team_id: 'team-1',
        agent_id: 'agent-b',
        name: 'TeamClu',
        path: '/Users/me/TeamClu',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveCloudWorkspaceIdForLocalPath('team-1', '~/TeamClu', { agentActorId: 'agent-b' }),
    ).resolves.toBe('ws-local')
  })
})

describe('resolveSessionWorkspaceHintForRuntimeStart', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('prefers the current local workspace path over the first agent-bound workspace', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-accounting',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'accounting-scripts',
        path: '/Users/me/accounting-scripts',
        archived: false,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'copilot-ws-v2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveSessionWorkspaceHintForRuntimeStart({
        teamId: 'team-1',
        localWorkspacePath: '/Users/me/copilot-ws-v2',
        agentActorIds: ['agent-1'],
        localDaemonActorId: 'agent-1',
      }),
    ).resolves.toBe('ws-copilot')
  })

  it('does not fall back to the remembered default for an existing session', async () => {
    useAgentDefaultWorkspaceStore.getState().clear()
    useAgentDefaultWorkspaceStore.getState().remember('agent-1', 'ws-remembered')

    await expect(
      resolveSessionWorkspaceHintForRuntimeStart({
        teamId: 'team-1',
        localWorkspacePath: '/Users/me/brand-new-folder',
        sessionId: 'sess-new',
        agentActorIds: ['agent-1'],
        localDaemonActorId: 'agent-1',
      }),
    ).resolves.toBe('')
  })
})

describe('ensureCloudWorkspaceIdForAgentRuntime', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.createDaemonWorkspace.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
    useAgentDefaultWorkspaceStore.getState().clear()
  })

  it('creates a cloud workspace when lookup and path match both fail', async () => {
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-new',
      team_id: 'team-1',
      agent_id: 'agent-1',
      name: 'TeamClu',
      path: '/Users/me/TeamClu',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/TeamClu',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-new')

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledWith({
      teamId: 'team-1',
      agentId: 'agent-1',
      createdByMemberId: 'member-1',
      name: 'TeamClu',
      path: '/Users/me/TeamClu',
    })
  })

  it('still creates when this agent has a cached default from a previous run', async () => {
    // The cache answers "what did this agent last start in", which is a hint.
    // It cannot answer "does THIS path already have a cloud workspace" — and
    // reading it here suppressed the create, leaving the runtime bound to a
    // workspace pointing at a different directory.
    useAgentDefaultWorkspaceStore.getState().remember('agent-1', 'ws-from-last-run')
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-new',
      team_id: 'team-1',
      agent_id: 'agent-1',
      name: 'TeamClu',
      path: '/Users/me/TeamClu',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/TeamClu',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-new')

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledTimes(1)
    // And the freshly created one replaces the stale cache entry.
    expect(useAgentDefaultWorkspaceStore.getState().recall('agent-1')).toBe('ws-new')
  })

  it('creates Copilot 361 instead of returning the agent first workspace TeamClaw', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-teamclaw',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'TeamClaw',
        path: '/Users/me/TeamClaw',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-copilot-361',
      team_id: 'team-1',
      agent_id: 'agent-1',
      name: 'Copilot 361',
      path: '/Users/me/Copilot 361',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/Copilot 361',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-copilot-361')

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledWith({
      teamId: 'team-1',
      agentId: 'agent-1',
      createdByMemberId: 'member-1',
      name: 'Copilot 361',
      path: '/Users/me/Copilot 361',
    })
  })

  it('reuses the same id when the window path only differs by a trailing slash', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'Copilot 361',
        path: '/Users/me/Copilot 361',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/Copilot 361/',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-copilot')

    expect(backendMocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('reuses an existing row for the same path_key even when it belongs to another agent', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-other',
        name: 'Copilot 361',
        path: '/Users/me/Copilot 361',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/Copilot 361/ios/../',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-copilot')

    expect(backendMocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('prefers the local daemon row when duplicate path_keys exist', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-other-agent',
        team_id: 'team-1',
        agent_id: 'agent-other',
        name: 'Copilot 361',
        path: '/Users/me/Copilot 361',
        archived: false,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'ws-local',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'Copilot 361',
        path: '/Users/me/Copilot 361',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/Copilot 361',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-local')
  })

  it('does not create when the path already resolves to a live workspace', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-live',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'TeamClu',
        path: '/Users/me/TeamClu',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/TeamClu',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-live')

    expect(backendMocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })
})
