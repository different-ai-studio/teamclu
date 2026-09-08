import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExportPiTranscriptButton } from '../ExportPiTranscriptButton'

const savePiTranscript = vi.fn()
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

vi.mock('@/lib/session/pi-transcript-export', () => ({
  savePiTranscript: (...args: unknown[]) => savePiTranscript(...args),
  exportTranscriptErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))

describe('ExportPiTranscriptButton', () => {
  it('saves the current session transcript', async () => {
    savePiTranscript.mockResolvedValue('/tmp/out.json')
    render(<ExportPiTranscriptButton sessionId="sess-9" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export session transcript' }))
    await waitFor(() => {
      expect(savePiTranscript).toHaveBeenCalledWith('sess-9')
      expect(toastSuccess).toHaveBeenCalled()
    })
  })

  it('toasts on failure', async () => {
    savePiTranscript.mockRejectedValue(new Error('no local pi session file'))
    render(<ExportPiTranscriptButton sessionId="sess-9" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export session transcript' }))
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
  })
})
