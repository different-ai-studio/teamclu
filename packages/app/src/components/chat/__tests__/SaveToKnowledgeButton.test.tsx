import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SaveToKnowledgeButton } from '../SaveToKnowledgeButton'

const proposeSessionToKnowledge = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('@/lib/knowledge/propose-from-session', () => ({
  proposeSessionToKnowledge: (...args: unknown[]) => proposeSessionToKnowledge(...args),
}))

describe('SaveToKnowledgeButton', () => {
  it('opens a review draft for the current session', async () => {
    proposeSessionToKnowledge.mockResolvedValue('cand-1')
    render(<SaveToKnowledgeButton sessionId="sess-9" />)
    fireEvent.click(screen.getByRole('button', { name: '整理到知识库' }))
    await waitFor(() => {
      expect(proposeSessionToKnowledge).toHaveBeenCalledWith('sess-9')
      expect(toastSuccess).toHaveBeenCalled()
    })
  })

  it('toasts on failure', async () => {
    proposeSessionToKnowledge.mockRejectedValue(new Error('daemon down'))
    render(<SaveToKnowledgeButton sessionId="sess-9" />)
    fireEvent.click(screen.getByRole('button', { name: '整理到知识库' }))
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
  })
})
