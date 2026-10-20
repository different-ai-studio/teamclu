import { beforeEach, describe, expect, it, vi } from 'vitest'

// The window folder. Polluted on purpose: `teamclu-workspace-path` survives
// restarts, so a path that arrived from another machine is exactly the state
// this resolution has to survive.
const FOREIGN_FOLDER = '/Users/someone-else/TeamClu'
const AGENT_ID = 'agent-local-daemon'
const TEAM_ID = 'team-1'

vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isTauri: () => true,
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: FOREIGN_FOLDER }) },
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ currentMember: { id: 'member-1' } }) },
}))
vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: async () => AGENT_ID,
}))

const h = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  loadAgentWorkspaceLookups: vi.fn(),
  resolveCloudWorkspaceIdForLocalPath: vi.fn(),
  ensureCloudWorkspaceIdForAgentRuntime: vi.fn(),
  runtimeStartWorkspaceArgs: vi.fn(),
}))
const {
  listDaemonWorkspaces,
  loadAgentWorkspaceLookups,
  resolveCloudWorkspaceIdForLocalPath,
  ensureCloudWorkspaceIdForAgentRuntime,
} = h

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ workspaces: { listDaemonWorkspaces: h.listDaemonWorkspaces } }),
}))
vi.mock('@/lib/teamclu/resolve-runtime-start-workspace', () => ({
  loadAgentWorkspaceLookups: h.loadAgentWorkspaceLookups,
  resolveCloudWorkspaceIdForLocalPath: h.resolveCloudWorkspaceIdForLocalPath,
  ensureCloudWorkspaceIdForAgentRuntime: h.ensureCloudWorkspaceIdForAgentRuntime,
  runtimeStartWorkspaceArgs: h.runtimeStartWorkspaceArgs,
}))

import { resolveLocalDaemonWorkspaceBinding } from '@/lib/session/session-create'

describe('resolveLocalDaemonWorkspaceBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listDaemonWorkspaces.mockResolvedValue([])
    loadAgentWorkspaceLookups.mockResolvedValue(new Map())
    resolveCloudWorkspaceIdForLocalPath.mockResolvedValue('')
    ensureCloudWorkspaceIdForAgentRuntime.mockResolvedValue('')
  })

  it("uses the agent's default workspace instead of the window folder", async () => {
    loadAgentWorkspaceLookups.mockResolvedValue(
      new Map([[AGENT_ID, { defaultWorkspaceId: 'ws-default' }]]),
    )
    listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-default', agent_id: AGENT_ID, path: '/Users/me/Work', archived: false },
    ])

    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, [AGENT_ID])

    expect(bound).toEqual({ agentId: AGENT_ID, workspaceId: 'ws-default', path: '/Users/me/Work' })
    // The folder must not even be consulted: resolving it matches on the path
    // string alone and would hand back another machine's workspace row.
    expect(resolveCloudWorkspaceIdForLocalPath).not.toHaveBeenCalled()
  })

  it('falls back to the owned workspace when no default is configured', async () => {
    loadAgentWorkspaceLookups.mockResolvedValue(
      new Map([[AGENT_ID, { ownedWorkspaceId: 'ws-owned' }]]),
    )
    listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-owned', agent_id: AGENT_ID, path: '/Users/me/Owned', archived: false },
    ])

    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, [AGENT_ID])

    expect(bound?.workspaceId).toBe('ws-owned')
    expect(bound?.path).toBe('/Users/me/Owned')
  })

  it('ignores a workspace row that carries no path', async () => {
    // An app's workspace row starts without one. Seating a local runtime on it
    // leaves the daemon with nothing to resolve, which is the failure the
    // window folder already caused.
    loadAgentWorkspaceLookups.mockResolvedValue(
      new Map([[AGENT_ID, { defaultWorkspaceId: 'ws-pathless' }]]),
    )
    listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-pathless', agent_id: AGENT_ID, path: null, archived: false },
    ])
    resolveCloudWorkspaceIdForLocalPath.mockResolvedValue('ws-from-folder')

    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, [AGENT_ID])

    expect(bound?.workspaceId).toBe('ws-from-folder')
    expect(bound?.path).toBe(FOREIGN_FOLDER)
  })

  it('ignores an archived workspace row', async () => {
    loadAgentWorkspaceLookups.mockResolvedValue(
      new Map([[AGENT_ID, { defaultWorkspaceId: 'ws-archived' }]]),
    )
    listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-archived', agent_id: AGENT_ID, path: '/Users/me/Old', archived: true },
    ])
    resolveCloudWorkspaceIdForLocalPath.mockResolvedValue('ws-from-folder')

    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, [AGENT_ID])

    expect(bound?.workspaceId).toBe('ws-from-folder')
  })

  it('still falls back to the window folder when the agent has no workspace', async () => {
    // Nothing is lost for a daemon that has never been given one — this is the
    // path that used to be the only one.
    resolveCloudWorkspaceIdForLocalPath.mockResolvedValue('ws-from-folder')

    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, [AGENT_ID])

    expect(bound).toEqual({
      agentId: AGENT_ID,
      workspaceId: 'ws-from-folder',
      path: FOREIGN_FOLDER,
    })
  })

  it('returns null when the local daemon is not a participant', async () => {
    const bound = await resolveLocalDaemonWorkspaceBinding(TEAM_ID, ['some-other-agent'])
    expect(bound).toBeNull()
    expect(loadAgentWorkspaceLookups).not.toHaveBeenCalled()
  })
})
