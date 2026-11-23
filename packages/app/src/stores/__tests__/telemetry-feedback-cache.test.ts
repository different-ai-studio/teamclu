import { beforeEach, describe, expect, it, vi } from 'vitest'

const listFeedbacksMock = vi.fn()
const deleteFeedbackMock = vi.fn()
const insertFeedbackMock = vi.fn()
const resolveActorMock = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    telemetry: { listFeedbacks: listFeedbacksMock, deleteFeedback: deleteFeedbackMock },
    directory: { resolveCurrentMemberActor: resolveActorMock },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' } }),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ session: { user: { id: 'user-1' } } }),
  },
}))

vi.mock('@/lib/telemetry/feedback', () => ({
  insertFeedback: (...args: unknown[]) => insertFeedbackMock(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

describe('useTelemetryStore.loadFeedbacks', () => {
  beforeEach(() => {
    vi.resetModules()
    listFeedbacksMock.mockReset()
    deleteFeedbackMock.mockReset()
    insertFeedbackMock.mockReset()
    resolveActorMock.mockReset()
    resolveActorMock.mockResolvedValue({ id: 'actor-me' })
  })

  it('loads only the current actor feedback into the cache', async () => {
    listFeedbacksMock.mockResolvedValue([
      { messageId: 'msg-a', actorId: 'actor-me', kind: 'positive', starRating: null },
      { messageId: 'msg-b', actorId: 'actor-other', kind: 'negative', starRating: null },
    ])

    const { useTelemetryStore } = await import('@/stores/telemetry')
    await useTelemetryStore.getState().loadFeedbacks('session-1')

    expect(useTelemetryStore.getState().feedbackCache.get('msg-a')).toBe('positive')
    expect(useTelemetryStore.getState().feedbackCache.has('msg-b')).toBe(false)
  })

  // The server holds one row per (actor, message) for both facets.
  it('keeps the stars when a thumb is given afterwards', async () => {
    const { useTelemetryStore } = await import('@/stores/telemetry')
    const store = useTelemetryStore.getState()
    await store.setStarRating('session-1', 'msg-a', 5)
    await store.setFeedback('session-1', 'msg-a', 'negative')

    expect(insertFeedbackMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-a', kind: 'negative', starRating: 5 }),
    )
    expect(useTelemetryStore.getState().starRatingCache.get('msg-a')).toBe(5)
    expect(useTelemetryStore.getState().feedbackCache.get('msg-a')).toBe('negative')
  })

  it('keeps the thumb when stars are given afterwards, without deleting the row first', async () => {
    const { useTelemetryStore } = await import('@/stores/telemetry')
    const store = useTelemetryStore.getState()
    await store.setFeedback('session-1', 'msg-a', 'negative')
    await store.setStarRating('session-1', 'msg-a', 5)

    expect(deleteFeedbackMock).not.toHaveBeenCalled()
    expect(insertFeedbackMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-a', kind: 'negative', starRating: 5 }),
    )
    expect(useTelemetryStore.getState().feedbackCache.get('msg-a')).toBe('negative')
  })

  it('shows the thumb a bare star rating stores, as a reload would', async () => {
    const { useTelemetryStore } = await import('@/stores/telemetry')
    await useTelemetryStore.getState().setStarRating('session-1', 'msg-a', 2)

    expect(useTelemetryStore.getState().feedbackCache.get('msg-a')).toBe('negative')
  })

  it('clears both facets when either is removed, because the row is deleted', async () => {
    const { useTelemetryStore } = await import('@/stores/telemetry')
    const store = useTelemetryStore.getState()
    await store.setFeedback('session-1', 'msg-a', 'positive')
    await store.setStarRating('session-1', 'msg-a', 4)
    await store.removeFeedback('session-1', 'msg-a')

    expect(deleteFeedbackMock).toHaveBeenCalledWith({ messageId: 'msg-a', actorId: 'actor-me' })
    expect(useTelemetryStore.getState().feedbackCache.has('msg-a')).toBe(false)
    expect(useTelemetryStore.getState().starRatingCache.has('msg-a')).toBe(false)
  })
})
