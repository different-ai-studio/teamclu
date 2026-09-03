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
        sessionId: 'sess-new',
        agentActorIds: ['agent-1'],
        localDaemonActorId: 'agent-1',
      }),
    ).resolves.toBe('ws-copilot')
  })

  // The other half of the #926 contract. That change stopped
  // ensureCloudWorkspaceIdForAgentRuntime from reading the cache, and pinned it
  // with two tests. Nothing pins the cache fallback that must REMAIN here.
  //
  // It is load-bearing: an empty hint makes the daemon skip its workspace
  // resolver entirely (runtime_lifecycle.rs runs it only when
  // `!workspace_id.is_empty()`) and start in whatever worktree the client
  // passed, so a new session's first send paid the backend cold start twice —
  // the 5.5s #921 measured. Deleting the fallback as "the thing that caused the
  // #926 bug" would silently bring that back, and no test would go red.
  it('falls back to the remembered default when nothing is live', async () => {
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
    ).resolves.toBe('ws-remembered')
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
