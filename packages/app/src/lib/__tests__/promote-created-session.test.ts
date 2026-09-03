import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertRows: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
  addHighlightedSession: vi.fn(),
  switchToSession: vi.fn().mockResolvedValue(undefined),
  requestComposerFocus: vi.fn(),
  ensureSessionLiveSubscribed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      upsertRows: mocks.upsertRows,
      load: mocks.load,
    }),
  },
}))

vi.mock('@/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({ addHighlightedSession: mocks.addHighlightedSession }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      switchToSession: mocks.switchToSession,
      requestComposerFocus: mocks.requestComposerFocus,
    }),
  },
}))

vi.mock('@/lib/session-live-subscriptions', () => ({
  ensureSessionLiveSubscribed: (...a: unknown[]) => mocks.ensureSessionLiveSubscribed(...a),
}))

describe('promoteCreatedSessionToUi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('upserts the row, switches immediately, and reconciles list in background', async () => {
    const { promoteCreatedSessionToUi } = await import('../promote-created-session')
    await promoteCreatedSessionToUi({
      sessionId: 'sess-1',
      teamId: 'team-1',
      title: 'Hello',
      lastMessagePreview: 'Hello world',
      focusComposer: true,
    })

    expect(mocks.upsertRows).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'sess-1',
        team_id: 'team-1',
        title: 'Hello',
        last_message_preview: 'Hello world',
        mode: 'collab',
      }),
    ])
    expect(mocks.addHighlightedSession).toHaveBeenCalledWith('sess-1')
    expect(mocks.switchToSession).toHaveBeenCalledWith('sess-1')
    expect(mocks.requestComposerFocus).toHaveBeenCalled()
    expect(mocks.ensureSessionLiveSubscribed).toHaveBeenCalledWith('team-1', 'sess-1')
    expect(mocks.load).toHaveBeenCalled()
  })
})
