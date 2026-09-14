import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeReviewTab } from '../KnowledgeReviewTab'

const getKnowledgeCandidate = vi.fn()
const publishKnowledgeCandidate = vi.fn()
const closeWhere = vi.fn()
const inboxLoad = vi.fn()
const inboxRemove = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))

vi.mock('@/lib/knowledge/inbox-client', () => ({
  getKnowledgeCandidate: (...args: unknown[]) => getKnowledgeCandidate(...args),
  publishKnowledgeCandidate: (...args: unknown[]) => publishKnowledgeCandidate(...args),
  isAlreadyExistsError: () => false,
}))

vi.mock('@/stores/tabs', () => ({
  useTabsStore: (sel: (s: { closeWhere: typeof closeWhere }) => unknown) =>
    sel({ closeWhere }),
}))

vi.mock('@/stores/knowledge-inbox', () => ({
  useKnowledgeInboxStore: {
    getState: () => ({ load: inboxLoad, remove: inboxRemove }),
  },
}))

vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: { getState: () => ({ syncRoot: null }) },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ selectFile: vi.fn() }) },
}))

describe('KnowledgeReviewTab', () => {
  beforeEach(() => {
    getKnowledgeCandidate.mockReset()
    publishKnowledgeCandidate.mockReset()
    closeWhere.mockReset()
    inboxLoad.mockReset()
    inboxRemove.mockReset()
    getKnowledgeCandidate.mockResolvedValue({
      id: 'cand-1',
      teamId: 't',
      sessionId: 'sess-1',
      title: '对账口径',
      body: '以渠道单号为准\n\n## 结论\n\n- 以渠道单号为准\n\n## 后续\n\n- 补一条 runbook',
      suggestedPath: '20-domains/对账口径.md',
      source: 'session-header',
      createdAt: '2026-09-11T00:00:00Z',
      status: 'pending',
      summary: '以渠道单号为准',
      suggestions: [
        { id: 'd-1', kind: 'decision', text: '以渠道单号为准' },
        { id: 'f-1', kind: 'followup', text: '补一条 runbook' },
      ],
    })
  })

  it('lets the reviewer uncheck a suggestion and drops it from the body', async () => {
    render(<KnowledgeReviewTab candidateId="cand-1" />)
    await screen.findByText('补一条 runbook')
    const boxes = screen.getAllByRole('checkbox')
    const followup = boxes.find((el) =>
      el.parentElement?.textContent?.includes('补一条 runbook'),
    )
    expect(followup).toBeTruthy()
    fireEvent.click(followup!)
    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement).value).not.toContain(
        '补一条 runbook',
      )
    })
  })

  it('does not overwrite a hand-edited body until rewrite is clicked', async () => {
    render(<KnowledgeReviewTab candidateId="cand-1" />)
    const textarea = (await screen.findByRole('textbox', { name: '正文' })) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '人手改过的正文' } })
    const followup = screen.getAllByRole('checkbox').find((el) =>
      el.parentElement?.textContent?.includes('补一条 runbook'),
    )
    fireEvent.click(followup!)
    expect(textarea.value).toBe('人手改过的正文')
    fireEvent.click(screen.getByRole('button', { name: '按所选建议重写正文' }))
    expect(textarea.value).not.toContain('人手改过的正文')
    expect(textarea.value).not.toContain('补一条 runbook')
    expect(textarea.value).toContain('以渠道单号为准')
  })
})
