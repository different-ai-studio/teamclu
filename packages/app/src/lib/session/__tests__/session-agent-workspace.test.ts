import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setParticipantWorkspace: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
  createDaemonWorkspace: vi.fn(),
  upsertSessionWorkspacesBatch: vi.fn(),
  invalidateViewerWorkspaceContext: vi.fn(),
  switchToSessionWorkspaceIfNeeded: vi.fn(),
  ensureAgentRuntimesForSession: vi.fn(),
  currentSessionId: 'sess-1' as string | null,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: { setParticipantWorkspace: mocks.setParticipantWorkspace },
  }),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
  createDaemonWorkspace: mocks.createDaemonWorkspace,
}))

vi.mock('@/lib/cache/local-cache', () => ({
  upsertSessionWorkspacesBatch: mocks.upsertSessionWorkspacesBatch,
}))

vi.mock('@/lib/session/session-viewer-workspace', () => ({
  invalidateViewerWorkspaceContext: mocks.invalidateViewerWorkspaceContext,
}))

vi.mock('@/lib/session/session-by-workspace', () => ({
  switchToSessionWorkspaceIfNeeded: mocks.switchToSessionWorkspaceIfNeeded,
}))

vi.mock('@/lib/teamclu/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: mocks.ensureAgentRuntimesForSession,
}))

vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: {
    getState: () => ({ currentSessionId: mocks.currentSessionId }),
  },
}))

import {
  bindSessionAgentWorkspace,
  ensureAgentWorkspaceForPath,
  WorkspaceHeldByAnotherAgentError,
} from '../session-agent-workspace'
import { sessionWorkspaceRebindRevision } from '../session-workspace-rebind'

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    teamId: 'team-1',
    agentId: 'agent-local',
    createdByMemberId: 'member-1',
    name: 'project',
    path: '/Users/me/project',
    archived: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

describe('ensureAgentWorkspaceForPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reuses the agent\'s live workspace for the folder instead of registering it again', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([
      workspaceRow({ id: 'ws-archived', archived: true }),
      workspaceRow({ id: 'ws-live', path: '/Users/me/project/' }),
    ])
    const out = await ensureAgentWorkspaceForPath({
      teamId: 'team-1',
      agentId: 'agent-local',
      memberId: 'member-1',
      path: '/Users/me/project',
    })
    expect(out.id).toBe('ws-live')
    expect(mocks.listDaemonWorkspaces).toHaveBeenCalledWith('team-1', 'agent-local')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('registers a folder that is not a workspace yet, named after it', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    mocks.createDaemonWorkspace.mockResolvedValue(workspaceRow({ id: 'ws-new', name: 'blog', path: '/Users/me/blog' }))
    const out = await ensureAgentWorkspaceForPath({
      teamId: 'team-1',
      agentId: 'agent-local',
      memberId: 'member-1',
      path: '/Users/me/blog',
    })
    expect(out.id).toBe('ws-new')
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledWith({
      teamId: 'team-1',
      agentId: 'agent-local',
      createdByMemberId: 'member-1',
      name: 'blog',
      path: '/Users/me/blog',
    })
  })

  // The Cloud API dedupes on the team's path and keeps the row's agent; a seat
  // would refuse that row, so fail here with something the user can act on.
  it('refuses a folder another agent in the team already holds', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    mocks.createDaemonWorkspace.mockResolvedValue(workspaceRow({ agentId: 'agent-other' }))
    await expect(
      ensureAgentWorkspaceForPath({
        teamId: 'team-1',
        agentId: 'agent-local',
        memberId: 'member-1',
        path: '/Users/me/project',
      }),
    ).rejects.toBeInstanceOf(WorkspaceHeldByAnotherAgentError)
  })
})

describe('bindSessionAgentWorkspace', () => {
  const args = {
    teamId: 'team-1',
    sessionId: 'sess-1',
    agentId: 'agent-local',
    viewerMemberId: 'member-1',
    workspace: { id: 'ws-1', path: '/Users/me/project' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentSessionId = 'sess-1'
    mocks.setParticipantWorkspace.mockResolvedValue(undefined)
    mocks.upsertSessionWorkspacesBatch.mockResolvedValue(undefined)
    mocks.switchToSessionWorkspaceIfNeeded.mockResolvedValue(undefined)
    mocks.ensureAgentRuntimesForSession.mockResolvedValue(undefined)
  })

  it('moves the seat, then the local binding, the pane, the window and the runtime after it', async () => {
    const before = sessionWorkspaceRebindRevision('sess-1')
    await bindSessionAgentWorkspace(args)

    expect(mocks.setParticipantWorkspace).toHaveBeenCalledWith('sess-1', 'agent-local', 'ws-1')
    expect(mocks.upsertSessionWorkspacesBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: 'sess-1',
        teamId: 'team-1',
        viewerMemberId: 'member-1',
        agentId: 'agent-local',
        workspaceId: 'ws-1',
        workspacePath: '/Users/me/project',
      }),
    ])
    expect(mocks.invalidateViewerWorkspaceContext).toHaveBeenCalledWith('team-1')
    expect(sessionWorkspaceRebindRevision('sess-1')).toBe(before + 1)
    expect(mocks.switchToSessionWorkspaceIfNeeded).toHaveBeenCalledWith('team-1', 'sess-1')
    expect(mocks.ensureAgentRuntimesForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorIds: ['agent-local'],
        workspaceIdHint: 'ws-1',
      }),
    )
  })

  it('leaves everything alone when the seat could not be written', async () => {
    mocks.setParticipantWorkspace.mockRejectedValue(new Error('403 forbidden'))
    const before = sessionWorkspaceRebindRevision('sess-1')
    await expect(bindSessionAgentWorkspace(args)).rejects.toThrow('403 forbidden')

    expect(mocks.upsertSessionWorkspacesBatch).not.toHaveBeenCalled()
    expect(sessionWorkspaceRebindRevision('sess-1')).toBe(before)
    expect(mocks.switchToSessionWorkspaceIfNeeded).not.toHaveBeenCalled()
    expect(mocks.ensureAgentRuntimesForSession).not.toHaveBeenCalled()
  })

  it('does not move the window once the user has left the session', async () => {
    mocks.currentSessionId = 'sess-elsewhere'
    await bindSessionAgentWorkspace(args)
    expect(mocks.switchToSessionWorkspaceIfNeeded).not.toHaveBeenCalled()
    expect(mocks.ensureAgentRuntimesForSession).toHaveBeenCalled()
  })

  it('still succeeds when only the local binding write fails', async () => {
    mocks.upsertSessionWorkspacesBatch.mockRejectedValue(new Error('libsql busy'))
    await expect(bindSessionAgentWorkspace(args)).resolves.toBeUndefined()
    expect(mocks.ensureAgentRuntimesForSession).toHaveBeenCalled()
  })
})
