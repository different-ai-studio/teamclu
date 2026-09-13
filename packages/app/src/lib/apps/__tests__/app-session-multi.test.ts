import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAppSessions: vi.fn(),
  addParticipant: vi.fn(),
  createSessionShell: vi.fn(),
  ensureAppCheckout: vi.fn(),
  bindAppWorkspaceInternals: vi.fn(),
  daemonAppWorkdir: vi.fn(),
  createDaemonWorkspace: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    apps: { listAppSessions: mocks.listAppSessions },
    sessionMembers: { addParticipant: mocks.addParticipant },
  }),
}))

vi.mock('@/lib/session/session-create', () => ({
  createSessionShell: mocks.createSessionShell,
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
  listDaemonWorkspaces: vi.fn().mockResolvedValue([]),
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
