import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageKind } from '@/lib/proto/teamclu_pb'

const proposeKnowledgeCandidate = vi.fn()
const openKnowledgeReview = vi.fn()
const inboxLoad = vi.fn()

vi.mock('@/lib/knowledge/inbox-client', () => ({
  proposeKnowledgeCandidate: (...args: unknown[]) => proposeKnowledgeCandidate(...args),
}))

vi.mock('@/lib/tabs/knowledge-tabs', () => ({
  openKnowledgeReview: (...args: unknown[]) => openKnowledgeReview(...args),
}))

vi.mock('@/stores/knowledge-inbox', () => ({
  useKnowledgeInboxStore: {
    getState: () => ({ load: inboxLoad }),
  },
}))

vi.mock('@/stores/session-message-store', () => ({
  useSessionMessageStore: {
    getState: () => ({
      messages: {
        'sess-1': [
          { kind: 1, content: '以渠道单号为准', senderActorId: 'alice' },
        ],
      },
    }),
  },
}))

vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ messages: {}, sessions: [] }) },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({ rows: [{ id: 'sess-1', title: '对账口径' }] }),
  },
}))

describe('proposeSessionToKnowledge', () => {
  beforeEach(() => {
    proposeKnowledgeCandidate.mockReset()
    openKnowledgeReview.mockReset()
    inboxLoad.mockReset()
    inboxLoad.mockResolvedValue(undefined)
  })

  it('proposes a pending candidate and opens the review tab', async () => {
    proposeKnowledgeCandidate.mockResolvedValue({ id: 'cand-9', title: '对账口径' })
    const { proposeSessionToKnowledge } = await import('@/lib/knowledge/propose-from-session')
    await proposeSessionToKnowledge('sess-1')
    expect(proposeKnowledgeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '对账口径',
        sessionId: 'sess-1',
        source: 'session-header',
        suggestedPath: '20-domains/对账口径.md',
      }),
    )
    const content = proposeKnowledgeCandidate.mock.calls[0][0].content as string
    expect(content).toContain('以渠道单号为准')
    expect(content).not.toContain(String(MessageKind.SYSTEM))
    expect(openKnowledgeReview).toHaveBeenCalledWith('cand-9', '对账口径')
    expect(inboxLoad).toHaveBeenCalled()
  })
})
