import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_STALE_EMPTY_SESSION_DAYS,
  EXTENSION_STALE_SESSION_DAYS,
  isEmptySession,
  runExtensionSessionCleanup,
  sessionLastActivityAt,
  shouldArchiveStaleExtensionSession,
} from '@/lib/extension/extension-session-cleanup'
import type { SessionListEntry } from '@/lib/backend/types'

const mocks = vi.hoisted(() => ({
  listCurrentActorSessions: vi.fn(),
  archiveSessionQuiet: vi.fn(),
  pinnedSessionIds: ['pinned-1'] as string[],
  activeSessionId: 'active-1' as string | null,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: {
      listCurrentActorSessions: mocks.listCurrentActorSessions,
    },
  }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      pinnedSessionIds: mocks.pinnedSessionIds,
      archiveSessionQuiet: mocks.archiveSessionQuiet,
    }),
  },
}))

vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: {
    getState: () => ({
      activeSessionId: mocks.activeSessionId,
    }),
  },
}))

function entry(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    id: 'session-1',
    title: 'Test',
    team_id: 'team-1',
    last_message_at: null,
    last_message_preview: null,
    mode: 'solo',
    idea_id: null,
    has_unread: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('extension-session-cleanup', () => {
  const now = new Date('2026-07-06T12:00:00.000Z')

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.pinnedSessionIds = ['pinned-1']
    mocks.activeSessionId = 'active-1'
    mocks.archiveSessionQuiet.mockResolvedValue(true)
  })

  it('treats sessions without messages as empty', () => {
    expect(isEmptySession(entry())).toBe(true)
    expect(isEmptySession(entry({ last_message_at: '2026-07-05T00:00:00.000Z' }))).toBe(false)
  })

  it('uses last_message_at for staleness even when updated_at is newer', () => {
    const stale = entry({
      last_message_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
    })
    expect(sessionLastActivityAt(stale)?.toISOString()).toBe('2026-06-20T00:00:00.000Z')
    expect(shouldArchiveStaleExtensionSession(stale, now)).toBe(true)
  })

  it(`archives sessions idle for ${EXTENSION_STALE_SESSION_DAYS}+ days`, () => {
    const stale = entry({
      last_message_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-06-20T00:00:00.000Z',
    })
    expect(shouldArchiveStaleExtensionSession(stale, now)).toBe(true)
  })

  it(`archives empty sessions idle for ${EXTENSION_STALE_EMPTY_SESSION_DAYS}+ days`, () => {
    const staleEmpty = entry({
      updated_at: '2026-07-02T00:00:00.000Z',
      created_at: '2026-07-02T00:00:00.000Z',
    })
    expect(shouldArchiveStaleExtensionSession(staleEmpty, now)).toBe(true)
  })

  it('keeps recent empty sessions', () => {
    const freshEmpty = entry({
      updated_at: '2026-07-05T00:00:00.000Z',
      created_at: '2026-07-05T00:00:00.000Z',
    })
    expect(shouldArchiveStaleExtensionSession(freshEmpty, now)).toBe(false)
  })

  it('keeps non-empty sessions younger than the long idle window', () => {
    const recentWithMessages = entry({
      last_message_at: '2026-07-04T00:00:00.000Z',
      updated_at: '2026-07-04T00:00:00.000Z',
    })
    expect(shouldArchiveStaleExtensionSession(recentWithMessages, now)).toBe(false)
  })

  it('skips active and pinned sessions during cleanup', async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [
        entry({ id: 'active-1', updated_at: '2026-06-01T00:00:00.000Z' }),
        entry({ id: 'pinned-1', updated_at: '2026-06-01T00:00:00.000Z' }),
        entry({ id: 'stale-1', updated_at: '2026-06-01T00:00:00.000Z' }),
      ],
      nextCursor: null,
    })

    const result = await runExtensionSessionCleanup({ now, force: true, userId: 'user-1', teamId: 'team-1' })

    expect(result).toEqual({ archived: 1, scanned: 3 })
    expect(mocks.archiveSessionQuiet).toHaveBeenCalledTimes(1)
    expect(mocks.archiveSessionQuiet).toHaveBeenCalledWith('stale-1')
  })

  it('re-checks active session before each archive', async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [
        entry({ id: 'stale-1', updated_at: '2026-06-01T00:00:00.000Z' }),
        entry({ id: 'stale-2', updated_at: '2026-06-01T00:00:00.000Z' }),
      ],
      nextCursor: null,
    })
    mocks.archiveSessionQuiet.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'stale-1') {
        mocks.activeSessionId = 'stale-2'
      }
      return true
    })

    const result = await runExtensionSessionCleanup({ now, force: true, userId: 'user-1', teamId: 'team-1' })

    expect(result).toEqual({ archived: 1, scanned: 2 })
    expect(mocks.archiveSessionQuiet).toHaveBeenCalledTimes(1)
    expect(mocks.archiveSessionQuiet).toHaveBeenCalledWith('stale-1')
  })

  it('paginates through all session pages', async () => {
    mocks.listCurrentActorSessions
      .mockResolvedValueOnce({
        rows: [entry({
          id: 'page-1',
          updated_at: '2026-07-05T00:00:00.000Z',
          created_at: '2026-07-05T00:00:00.000Z',
        })],
        nextCursor: {
          lastMessageAt: null,
          createdAt: '2026-07-01T00:00:00.000Z',
          id: 'page-1',
        },
      })
      .mockResolvedValueOnce({
        rows: [entry({ id: 'stale-2', updated_at: '2026-06-01T00:00:00.000Z' })],
        nextCursor: null,
      })

    const result = await runExtensionSessionCleanup({ now, force: true, userId: 'user-1', teamId: 'team-1' })

    expect(mocks.listCurrentActorSessions).toHaveBeenCalledTimes(2)
    expect(result.archived).toBe(1)
    expect(mocks.archiveSessionQuiet).toHaveBeenCalledWith('stale-2')
  })

  it('respects the minimum gap between sweeps per user and team', async () => {
    localStorage.setItem(
      'teamclu.extension.sessionCleanupLastRun.user-1.team-1',
      String(now.getTime()),
    )

    const result = await runExtensionSessionCleanup({ now, userId: 'user-1', teamId: 'team-1' })

    expect(result).toEqual({ archived: 0, scanned: 0 })
    expect(mocks.listCurrentActorSessions).not.toHaveBeenCalled()
  })

  it('does not write lastRun when archive fails', async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [entry({ id: 'stale-1', updated_at: '2026-06-01T00:00:00.000Z' })],
      nextCursor: null,
    })
    mocks.archiveSessionQuiet.mockResolvedValueOnce(false)

    const result = await runExtensionSessionCleanup({ now, force: true, userId: 'user-1', teamId: 'team-1' })

    expect(result).toEqual({ archived: 0, scanned: 1 })
    expect(localStorage.getItem('teamclu.extension.sessionCleanupLastRun.user-1.team-1')).toBeNull()
  })

  it('writes lastRun only after a fully successful sweep', async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [entry({ id: 'stale-1', updated_at: '2026-06-01T00:00:00.000Z' })],
      nextCursor: null,
    })

    await runExtensionSessionCleanup({ now, force: true, userId: 'user-1', teamId: 'team-1' })

    expect(localStorage.getItem('teamclu.extension.sessionCleanupLastRun.user-1.team-1')).toBe(
      String(now.getTime()),
    )
  })
})
