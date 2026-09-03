import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAppSessions: vi.fn(),
  addParticipant: vi.fn(),
  createSessionShell: vi.fn(),
  ensureAppCheckout: vi.fn(),
  bindAppWorkspaceInternals: vi.fn(),
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
  daemonAppWorkdir: vi.fn().mockResolvedValue({ workdir: '/workdir/app-1', deviceName: 'test-host' }),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: vi.fn().mockResolvedValue([]),
  createDaemonWorkspace: vi.fn(),
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

describe('ensureAppSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    vi.clearAllMocks()
    mocks.ensureAppCheckout.mockResolvedValue(undefined)
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'new-session' })
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
})
