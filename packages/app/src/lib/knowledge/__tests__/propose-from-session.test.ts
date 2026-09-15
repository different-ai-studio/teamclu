import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageKind } from '@/lib/proto/teamclu_pb'

const proposeKnowledgeCandidate = vi.fn()
const openKnowledgeReview = vi.fn()
const inboxLoad = vi.fn()
const distillWithTeamLlm = vi.fn()

vi.mock('@/lib/knowledge/inbox-client', () => ({
  proposeKnowledgeCandidate: (...args: unknown[]) => proposeKnowledgeCandidate(...args),
}))

vi.mock('@/lib/tabs/knowledge-tabs', () => ({
  openKnowledgeReview: (...args: unknown[]) => openKnowledgeReview(...args),
}))

vi.mock('@/lib/knowledge/session-knowledge-llm', () => ({
  distillWithTeamLlm: (...args: unknown[]) => distillWithTeamLlm(...args),
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
          {
            kind: MessageKind.TEXT,
            content: `过程记录。${'用户贴了一大段过程记录。'.repeat(20)}`,
            senderActorId: 'alice',
          },
          {
            kind: MessageKind.AGENT_REPLY,
            content: '结论：以渠道单号为准。\n- 下一步补一条 runbook',
            senderActorId: 'agent-1',
          },
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

vi.mock('@/stores/session-participant-store', () => ({
  useSessionParticipantStore: {
    getState: () => ({
      participantsBySession: {
        'sess-1': [
          { actorId: 'alice', isAgent: false },
          { actorId: 'agent-1', isAgent: true },
        ],
      },
    }),
  },
}))

describe('proposeSessionToKnowledge', () => {
  beforeEach(() => {
    proposeKnowledgeCandidate.mockReset()
    openKnowledgeReview.mockReset()
    inboxLoad.mockReset()
    distillWithTeamLlm.mockReset()
    inboxLoad.mockResolvedValue(undefined)
    distillWithTeamLlm.mockResolvedValue(null)
    proposeKnowledgeCandidate.mockResolvedValue({ id: 'cand-9', title: '对账口径' })
  })

  it('proposes distilled suggestions instead of the full transcript', async () => {
    const { proposeSessionToKnowledge } = await import('@/lib/knowledge/propose-from-session')
    await proposeSessionToKnowledge('sess-1')
    const payload = proposeKnowledgeCandidate.mock.calls[0][0] as {
      content: string
      suggestions: Array<{ text: string }>
    }
    expect(payload.content).toContain('以渠道单号为准')
    expect(payload.content).not.toContain('用户贴了一大段过程记录')
    expect(payload.content).not.toContain('### alice')
    expect(payload.suggestions.some((item) => item.text.includes('渠道单号'))).toBe(true)
    expect(proposeKnowledgeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '对账口径',
        sessionId: 'sess-1',
        source: 'session-header',
        suggestedPath: '20-domains/对账口径.md',
      }),
    )
    expect(openKnowledgeReview).toHaveBeenCalledWith('cand-9', '对账口径')
  })

  it('prefers the team-model distill when it returns a draft', async () => {
    distillWithTeamLlm.mockResolvedValue({
      title: 'LLM 标题',
      body: '## 结论\n\n- 模型提炼的结论',
      suggestedPath: '20-domains/llm.md',
      summary: '模型提炼的结论',
      suggestions: [{ id: 'd-1', kind: 'decision', text: '模型提炼的结论' }],
    })
    const { proposeSessionToKnowledge } = await import('@/lib/knowledge/propose-from-session')
    await proposeSessionToKnowledge('sess-1')
    expect(proposeKnowledgeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'LLM 标题',
        content: '## 结论\n\n- 模型提炼的结论',
        summary: '模型提炼的结论',
      }),
    )
  })
})
