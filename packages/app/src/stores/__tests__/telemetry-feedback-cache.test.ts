import { beforeEach, describe, expect, it, vi } from 'vitest'

const listFeedbacksMock = vi.fn()
const resolveActorMock = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    telemetry: { listFeedbacks: listFeedbacksMock },
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

vi.mock('@/lib/telemetry/supabase-feedback', () => ({
  insertFeedback: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

describe('useTelemetryStore.loadFeedbacks', () => {
  beforeEach(() => {
    vi.resetModules()
    listFeedbacksMock.mockReset()
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
})
