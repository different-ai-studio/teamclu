import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAppSessions: vi.fn(),
  addParticipant: vi.fn(),
  setParticipantWorkspace: vi.fn(),
  listWorkspacesByIds: vi.fn(),
  createSessionShell: vi.fn(),
  createSessionWithFirstMessage: vi.fn(),
  startAgentRuntimesAsync: vi.fn(),
  ensureAppCheckout: vi.fn(),
  bindAppWorkspaceInternals: vi.fn(),
  daemonAppWorkdir: vi.fn(),
  createDaemonWorkspace: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    apps: { listAppSessions: mocks.listAppSessions },
    sessionMembers: {
      addParticipant: mocks.addParticipant,
      setParticipantWorkspace: mocks.setParticipantWorkspace,
    },
    workspaces: { listWorkspacesByIds: mocks.listWorkspacesByIds },
  }),
}))

vi.mock('@/lib/session/session-create', () => ({
  createSessionShell: mocks.createSessionShell,
  createSessionWithFirstMessage: mocks.createSessionWithFirstMessage,
  startAgentRuntimesAsync: mocks.startAgentRuntimesAsync,
}))

vi.mock('@/stores/apps-store', () => ({
  ensureAppCheckout: mocks.ensureAppCheckout,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn().mockResolvedValue('daemon-1'),
}))

vi.mock('@/lib/actor/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn().mockResolvedValue('creator-1'),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } }),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonAppWorkdir: mocks.daemonAppWorkdir,
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
  createDaemonWorkspace: mocks.createDaemonWorkspace,
}))

vi.mock('@/lib/cache/local-cache', () => ({
  upsertSessionWorkspacesBatch: vi.fn(),
}))

const app = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo',
  type: 'static_web',
  workspaceId: 'ws-1',
  provisionStatus: 'ready',
} as const

beforeEach(() => {
  vi.clearAllMocks()
  mocks.daemonAppWorkdir.mockResolvedValue({ workdir: '/workdir/app-1', deviceName: 'test-host' })
  mocks.createDaemonWorkspace.mockResolvedValue({ id: 'ws-new' })
  mocks.listWorkspacesByIds.mockResolvedValue([])
  mocks.listDaemonWorkspaces.mockResolvedValue([])
  mocks.setParticipantWorkspace.mockResolvedValue(undefined)
})

describe('ensureAppSession', () => {
  beforeEach(() => {
    mocks.ensureAppCheckout.mockResolvedValue(undefined)
    mocks.listAppSessions.mockResolvedValue([])
    mocks.addParticipant.mockResolvedValue(undefined)
  })

  it('returns null when the app has no sessions (does not create one)', async () => {
    const { ensureAppSession } = await import('@/lib/apps/app-session')
    await expect(ensureAppSession(app as never)).resolves.toBeNull()
    expect(mocks.createSessionShell).not.toHaveBeenCalled()
  })

  it('opens the most recent session when one exists', async () => {
    mocks.listAppSessions.mockResolvedValue([
      {
        id: 'old',
        teamId: 'team-1',
        title: 'Old',
        mode: 'collab',
        lastMessageAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'recent',
        teamId: 'team-1',
        title: 'Recent',
        mode: 'collab',
        lastMessageAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
      },
    ])
    const { ensureAppSession } = await import('@/lib/apps/app-session')
    await expect(ensureAppSession(app as never)).resolves.toBe('recent')
    expect(mocks.addParticipant).toHaveBeenCalledWith('recent', 'daemon-1')
  })
})

describe('createAppSessionShell', () => {
  beforeEach(() => {
    mocks.ensureAppCheckout.mockResolvedValue(undefined)
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'new-session' })
    mocks.addParticipant.mockResolvedValue(undefined)
  })

  it('creates an empty session linked to the app', async () => {
    const { createAppSessionShell } = await import('@/lib/apps/app-session')
    await expect(createAppSessionShell(app as never)).resolves.toBe('new-session')
    expect(mocks.createSessionShell).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        creatorActorId: 'creator-1',
        title: 'Demo',
        appId: 'app-1',
        additionalActorIds: ['daemon-1'],
      }),
    )
  })

  it('does not repeat the setup the first time the new session is opened', async () => {
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'new-session-opened' })
    const { createAppSessionShell, openAppSession } = await import('@/lib/apps/app-session')
    await createAppSessionShell(app as never)
    mocks.addParticipant.mockClear()

    await openAppSession(app as never, 'new-session-opened')

    expect(mocks.addParticipant).not.toHaveBeenCalled()
  })
})

describe('openAppSession', () => {
  beforeEach(() => {
    mocks.ensureAppCheckout.mockResolvedValue(undefined)
    mocks.addParticipant.mockResolvedValue(undefined)
  })

  it('seats the daemon and binds the checkout once, however often the session is switched to', async () => {
    // Switching back and forth in the app's session list calls this every
    // time; redoing a Cloud API write per click was what made the list slow.
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'switch-back-and-forth')
    await openAppSession(app as never, 'switch-back-and-forth')
    await openAppSession(app as never, 'switch-back-and-forth')

    expect(mocks.addParticipant).toHaveBeenCalledTimes(1)
    expect(mocks.addParticipant).toHaveBeenCalledWith('switch-back-and-forth', 'daemon-1')
  })

  it('tries the seat again on the next open when it failed', async () => {
    mocks.addParticipant.mockRejectedValueOnce(new Error('offline'))
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'seat-failed-once')
    await openAppSession(app as never, 'seat-failed-once')

    expect(mocks.addParticipant).toHaveBeenCalledTimes(2)
  })

  it('does not ask the daemon for the directory the checkout step already found', async () => {
    mocks.ensureAppCheckout.mockResolvedValue('/workdir/app-1')
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'known-workdir')

    expect(mocks.daemonAppWorkdir).not.toHaveBeenCalled()
  })

  it('still asks the daemon when the checkout step had no directory to give', async () => {
    mocks.ensureAppCheckout.mockResolvedValue(null)
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'unknown-workdir')

    expect(mocks.daemonAppWorkdir).toHaveBeenCalledWith('app-1', 'team-1')
  })
})

/**
 * The daemon's seat names the folder the file tree and runtime-start resolve
 * for it. A seat created without one gets the agent's default workspace, which
 * is how an app session showed that folder while its agent worked in the
 * checkout (#1430).
 */
describe("the local daemon's seat", () => {
  const mine = { id: 'ws-mine', agentId: 'daemon-1', archived: false, path: '/workdir/app-1' }

  beforeEach(() => {
    mocks.ensureAppCheckout.mockResolvedValue('/workdir/app-1')
    mocks.addParticipant.mockResolvedValue(undefined)
    mocks.createDaemonWorkspace.mockResolvedValue(mine)
  })

  it('is created on the checkout with a new empty session', async () => {
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'seat-shell' })
    const { createAppSessionShell } = await import('@/lib/apps/app-session')
    await createAppSessionShell(app as never)

    expect(mocks.createSessionShell).toHaveBeenCalledWith(
      expect.objectContaining({
        localWorkspace: { agentId: 'daemon-1', workspaceId: 'ws-mine', path: '/workdir/app-1' },
      }),
    )
    // Already there, so nothing to move.
    expect(mocks.setParticipantWorkspace).not.toHaveBeenCalled()
  })

  it('is created on the checkout with the first session of a new app', async () => {
    mocks.createSessionWithFirstMessage.mockResolvedValue({ sessionId: 'seat-first' })
    mocks.startAgentRuntimesAsync.mockResolvedValue({ failures: [], runtimeIdsByAgent: {} })
    const { startAppFirstSession } = await import('@/lib/apps/app-session')
    await startAppFirstSession(app as never)

    expect(mocks.createSessionWithFirstMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        localWorkspace: { agentId: 'daemon-1', workspaceId: 'ws-mine', path: '/workdir/app-1' },
      }),
    )
    expect(mocks.setParticipantWorkspace).not.toHaveBeenCalled()
  })

  it('is moved onto the checkout when an existing session is opened', async () => {
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'seat-on-default')

    expect(mocks.setParticipantWorkspace).toHaveBeenCalledWith('seat-on-default', 'daemon-1', 'ws-mine')
  })

  // With the window already on the checkout nothing else moves, and the files
  // pane kept the "no workspace" answer it resolved before the seat did.
  it('tells the files pane to resolve again once the seat is on the checkout', async () => {
    const { sessionWorkspaceRebindRevision } = await import('@/lib/session/session-workspace-rebind')
    const before = sessionWorkspaceRebindRevision('seat-rebind-note')
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'seat-rebind-note')

    expect(sessionWorkspaceRebindRevision('seat-rebind-note')).toBe(before + 1)
  })

  it('is moved again on the next open when the move failed', async () => {
    mocks.setParticipantWorkspace.mockRejectedValueOnce(new Error('offline'))
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'seat-move-failed')
    await openAppSession(app as never, 'seat-move-failed')

    expect(mocks.setParticipantWorkspace).toHaveBeenCalledTimes(2)
  })

  // Both machines lay their home out identically and share the app's row. The
  // seat can take it, but only by a move: a Cloud API from before shared-path
  // seats refuses another agent's row at create time and fails the create.
  it("is moved onto the row another machine's daemon registered for the same path", async () => {
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-1', name: 'w', path: '/workdir/app-1', agentId: 'daemon-other', archived: false },
    ])
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'seat-shared-row' })
    const { createAppSessionShell, openAppSession } = await import('@/lib/apps/app-session')
    await createAppSessionShell(app as never)
    await openAppSession(app as never, 'seat-shared-row-opened')

    expect(mocks.createSessionShell).toHaveBeenCalledWith(
      expect.objectContaining({ localWorkspace: null }),
    )
    expect(mocks.setParticipantWorkspace).toHaveBeenCalledWith('seat-shared-row', 'daemon-1', 'ws-1')
    expect(mocks.setParticipantWorkspace).toHaveBeenCalledWith('seat-shared-row-opened', 'daemon-1', 'ws-1')
  })

  it('takes a shared row found by path instead of posting the folder again', async () => {
    // The app's own row names another machine's directory, so this machine
    // looks for a row of its own directory — which another daemon registered.
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-1', name: 'w', path: '/elsewhere/app-1', agentId: 'daemon-other', archived: false },
    ])
    mocks.listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-shared', agentId: 'daemon-other', archived: false, path: '/workdir/app-1' },
    ])
    const { openAppSession } = await import('@/lib/apps/app-session')
    await openAppSession(app as never, 'seat-shared-by-path')

    expect(mocks.listDaemonWorkspaces).toHaveBeenCalledWith('team-1')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
    expect(mocks.setParticipantWorkspace).toHaveBeenCalledWith('seat-shared-by-path', 'daemon-1', 'ws-shared')
  })
})
