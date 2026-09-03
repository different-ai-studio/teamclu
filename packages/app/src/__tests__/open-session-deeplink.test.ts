import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID = '33c0b7a2-385d-4f77-b92c-9801819530bd'
const TEAM_A = 'team-a'
const TEAM_B = 'team-b'

const mocks = vi.hoisted(() => ({
  joinSession: vi.fn(),
  enterTeam: vi.fn(),
  switchToSession: vi.fn(),
  load: vi.fn(),
  upsertRows: vi.fn(),
  session: { user: { id: 'user-1', is_anonymous: false } } as
    | { user: { id: string; is_anonymous?: boolean } }
    | null,
  teamId: 'team-a' as string | null,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: { joinSession: mocks.joinSession },
  }),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ session: mocks.session }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: mocks.teamId ? { id: mocks.teamId } : null,
      enterTeam: mocks.enterTeam,
    }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ switchToSession: mocks.switchToSession }),
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({ load: mocks.load, upsertRows: mocks.upsertRows }),
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

import {
  clearPendingSessionDeeplink,
  completePendingSessionDeeplink,
  openSessionFromDeeplink,
  readPendingSessionDeeplink,
  stashPendingSessionDeeplink,
} from '@/lib/session/open-session-deeplink'

describe('openSessionFromDeeplink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.session = { user: { id: 'user-1', is_anonymous: false } }
    mocks.teamId = TEAM_A
    mocks.joinSession.mockResolvedValue({
      id: UUID,
      team_id: TEAM_A,
      title: 'Linked session',
      mode: 'collab',
      idea_id: null,
      last_message_at: '2026-08-01T00:00:00.000Z',
      last_message_preview: 'Earlier message',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    })
    mocks.enterTeam.mockResolvedValue(undefined)
    mocks.switchToSession.mockResolvedValue(undefined)
    mocks.load.mockResolvedValue(undefined)
  })

  it('stashes the session when auth is not ready', async () => {
    mocks.session = null
    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(false)
    expect(readPendingSessionDeeplink()?.sessionId).toBe(UUID)
    expect(mocks.joinSession).not.toHaveBeenCalled()
  })

  it('navigates immediately when the session is in the active team', async () => {
    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(true)
    expect(mocks.joinSession).toHaveBeenCalledWith(UUID)
    expect(mocks.enterTeam).not.toHaveBeenCalled()
    expect(mocks.switchToSession).toHaveBeenCalledWith(UUID)
    expect(mocks.load).toHaveBeenCalled()
    expect(readPendingSessionDeeplink()).toBeNull()
  })

  it('keeps a joined session visible when it falls outside the refreshed first page', async () => {
    const ok = await openSessionFromDeeplink(UUID)

    expect(ok).toBe(true)
    expect(mocks.upsertRows).toHaveBeenCalledTimes(2)
    expect(mocks.upsertRows).toHaveBeenLastCalledWith([expect.objectContaining({
      id: UUID,
      team_id: TEAM_A,
      title: 'Linked session',
      last_message_preview: 'Earlier message',
    })])
    expect(mocks.upsertRows.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.switchToSession.mock.invocationCallOrder[0])
    expect(mocks.upsertRows.mock.invocationCallOrder[1])
      .toBeGreaterThan(mocks.load.mock.invocationCallOrder[0])
  })

  it('defers navigation across team switches', async () => {
    mocks.joinSession.mockResolvedValue({
      id: UUID,
      team_id: TEAM_B,
      title: 'Other team session',
      mode: 'collab',
      idea_id: null,
      last_message_at: null,
      last_message_preview: null,
      created_at: null,
      updated_at: null,
    })
    mocks.teamId = TEAM_A

    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(true)
    expect(mocks.enterTeam).toHaveBeenCalledWith(TEAM_B)
    expect(mocks.switchToSession).not.toHaveBeenCalled()
    expect(readPendingSessionDeeplink()).toEqual(expect.objectContaining({
      sessionId: UUID,
      teamId: TEAM_B,
      sessionRow: expect.objectContaining({ id: UUID, team_id: TEAM_B }),
    }))
  })
})

describe('completePendingSessionDeeplink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.session = { user: { id: 'user-1', is_anonymous: false } }
    mocks.teamId = TEAM_B
    mocks.switchToSession.mockResolvedValue(undefined)
    mocks.load.mockResolvedValue(undefined)
  })

  it('opens the stashed session once the target team is active', async () => {
    stashPendingSessionDeeplink(UUID, TEAM_B, {
      id: UUID,
      team_id: TEAM_B,
      title: 'Other team session',
      last_message_at: null,
      last_message_preview: null,
      mode: 'collab',
      idea_id: null,
      has_unread: false,
      source: null,
      cron_job_id: null,
      created_at: null,
      updated_at: null,
    })
    const ok = await completePendingSessionDeeplink()
    expect(ok).toBe(true)
    expect(mocks.switchToSession).toHaveBeenCalledWith(UUID)
    expect(mocks.upsertRows).toHaveBeenCalledTimes(2)
    expect(readPendingSessionDeeplink()).toBeNull()
  })

  it('waits until the active team matches the pending target team', async () => {
    stashPendingSessionDeeplink(UUID, TEAM_B)
    mocks.teamId = TEAM_A
    const ok = await completePendingSessionDeeplink()
    expect(ok).toBe(false)
    expect(mocks.switchToSession).not.toHaveBeenCalled()
    expect(readPendingSessionDeeplink()?.sessionId).toBe(UUID)
  })
})

describe('pending session deeplink storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips through localStorage', () => {
    stashPendingSessionDeeplink(UUID, TEAM_A)
    expect(readPendingSessionDeeplink()).toEqual({ sessionId: UUID, teamId: TEAM_A })
    clearPendingSessionDeeplink()
    expect(readPendingSessionDeeplink()).toBeNull()
  })
})
