import { beforeEach, describe, expect, it, vi } from 'vitest'

const proposeKnowledgeCandidate = vi.fn()
const openKnowledgeReview = vi.fn()
const inboxLoad = vi.fn()
const distillDocumentWithTeamLlm = vi.fn()
const fetchDocuments = vi.fn()
const readText = vi.fn()

vi.mock('@/lib/knowledge/inbox-client', () => ({
  proposeKnowledgeCandidate: (...args: unknown[]) => proposeKnowledgeCandidate(...args),
}))

vi.mock('@/lib/tabs/knowledge-tabs', () => ({
  openKnowledgeReview: (...args: unknown[]) => openKnowledgeReview(...args),
}))

vi.mock('@/lib/knowledge/session-knowledge-llm', () => ({
  distillDocumentWithTeamLlm: (...args: unknown[]) => distillDocumentWithTeamLlm(...args),
}))

vi.mock('@/stores/knowledge-inbox', () => ({
  useKnowledgeInboxStore: {
    getState: () => ({ load: inboxLoad }),
  },
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  fetchDocuments: (...args: unknown[]) => fetchDocuments(...args),
}))

describe('proposeDocumentToKnowledge', () => {
  beforeEach(() => {
    proposeKnowledgeCandidate.mockReset()
    openKnowledgeReview.mockReset()
    inboxLoad.mockReset()
    distillDocumentWithTeamLlm.mockReset()
    fetchDocuments.mockReset()
    readText.mockReset()
    inboxLoad.mockResolvedValue(undefined)
    distillDocumentWithTeamLlm.mockResolvedValue(null)
    fetchDocuments.mockResolvedValue(1)
    proposeKnowledgeCandidate.mockResolvedValue({ id: 'cand-d', title: '对账口径' })
  })

  it('proposes distilled markdown instead of the full document', async () => {
    const wall = `背景说明。${'这篇资料里贴了一大段过程记录。'.repeat(20)}`
    readText.mockResolvedValue(
      [wall, '', '## 结论', '- 以渠道单号为准'].join('\n'),
    )
    const { proposeDocumentToKnowledge } = await import('@/lib/knowledge/propose-from-document')
    await proposeDocumentToKnowledge({
      absPath: '/vault/documents/finance/对账口径.md',
      documentPath: 'documents/finance/对账口径.md',
      workspacePath: '/vault',
      readText,
    })
    const payload = proposeKnowledgeCandidate.mock.calls[0][0] as {
      content: string
      suggestions: Array<{ text: string }>
    }
    expect(payload.content).toContain('以渠道单号为准')
    expect(payload.content).not.toContain('这篇资料里贴了一大段过程记录')
    expect(proposeKnowledgeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '对账口径',
        source: 'document',
        documentPath: 'documents/finance/对账口径.md',
        suggestedPath: '20-domains/对账口径.md',
      }),
    )
    expect(openKnowledgeReview).toHaveBeenCalledWith('cand-d', '对账口径')
    expect(fetchDocuments).not.toHaveBeenCalled()
  })

  it('does not read bytes for a known binary; proposes a pointer page', async () => {
    const { proposeDocumentToKnowledge } = await import('@/lib/knowledge/propose-from-document')
    await proposeDocumentToKnowledge({
      absPath: '/vault/documents/hr/合同.pdf',
      documentPath: 'documents/hr/合同.pdf',
      workspacePath: '/vault',
      readText,
    })
    expect(readText).not.toHaveBeenCalled()
    expect(distillDocumentWithTeamLlm).not.toHaveBeenCalled()
    expect(proposeKnowledgeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '合同',
        source: 'document',
        documentPath: 'documents/hr/合同.pdf',
      }),
    )
    const payload = proposeKnowledgeCandidate.mock.calls[0][0] as { content: string }
    expect(payload.content).toContain('documents/hr/合同.pdf')
  })

  it('fetches a listed-only document before reading', async () => {
    readText.mockResolvedValue('结论：以渠道单号为准。')
    const { proposeDocumentToKnowledge } = await import('@/lib/knowledge/propose-from-document')
    await proposeDocumentToKnowledge({
      absPath: '/vault/documents/finance/对账口径.md',
      documentPath: 'documents/finance/对账口径.md',
      workspacePath: '/vault',
      needsFetch: true,
      teamId: 'team-1',
      readText,
    })
    expect(fetchDocuments).toHaveBeenCalledWith('team-1', ['documents/finance/对账口径.md'])
    expect(readText).toHaveBeenCalled()
  })
})
