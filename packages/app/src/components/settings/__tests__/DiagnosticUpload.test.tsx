import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import en from '@/locales/en.json'
import zh from '@/locales/zh-CN.json'
import type { DiagnosticReport } from '@/lib/diagnostics/diagnostic-report'
import { DiagnosticUpload, resetDiagnosticUploadAvailabilityForTest } from '../DiagnosticUpload'

const upload = vi.hoisted(() => vi.fn())
const desktop = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/diagnostics/diagnostic-upload', () => ({ uploadDiagnosticZip: upload }))
vi.mock('@/lib/utils', () => ({ isTauri: () => desktop.value, cn: (...args: string[]) => args.filter(Boolean).join(' ') }))
const i18n = i18next.createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: en }, 'zh-CN': { translation: zh } } })
const report = { generatedAt: 'test' } as DiagnosticReport
const receipt = { receiptId: '6df63b93-5b85-4f16-a891-2c17fb6afc30', expiresAt: '2026-11-22T12:00:00.000Z' }
function renderUpload(disabled = false) {
  return render(<I18nextProvider i18n={i18n}><DiagnosticUpload report={report} disabled={disabled} /></I18nextProvider>)
}
async function confirmUpload() {
  fireEvent.click(screen.getByRole('button', { name: 'Upload to support' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Agree and upload' }))
}

describe('DiagnosticUpload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetDiagnosticUploadAvailabilityForTest()
    desktop.value = true
    await i18n.changeLanguage('en')
    upload.mockResolvedValue(receipt)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })
  afterEach(cleanup)

  it('shows disclosure and requires explicit consent; cancel uploads nothing', async () => {
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload to support' }))
    expect(await screen.findByText(/logs may still contain personal data/)).toBeTruthy()
    expect(upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(upload).not.toHaveBeenCalled()
  })

  it('shows loading, receipt, expiry and successful copy', async () => {
    let finish!: (value: typeof receipt) => void
    upload.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    renderUpload()
    await confirmUpload()
    expect(screen.getByRole('button', { name: 'Generating and uploading…' })).toBeDisabled()
    finish(receipt)
    expect(await screen.findByText(receipt.receiptId)).toBeTruthy()
    expect(upload).toHaveBeenCalledExactlyOnceWith(report)
    expect(screen.getByText(/Receipt expires:/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy receipt' }))
    await screen.findByRole('button', { name: 'Receipt copied' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(receipt.receiptId)
  })

  it('shows readable failure, enables retry, and keeps success copyable if clipboard fails', async () => {
    upload.mockRejectedValueOnce(new Error('Network unavailable'))
    renderUpload()
    await confirmUpload()
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
    expect(screen.getByRole('button', { name: 'Upload to support' })).not.toBeDisabled()
    await confirmUpload()
    await screen.findByText(receipt.receiptId)
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy receipt' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Select and copy'))
    expect(screen.getByText(receipt.receiptId)).toBeTruthy()
  })

  it('disables upload while diagnostics/export busy or not on desktop', () => {
    const view = renderUpload(true)
    expect(screen.getByRole('button', { name: 'Upload to support' })).toBeDisabled()
    view.unmount()
    desktop.value = false
    renderUpload()
    expect(screen.getByRole('button', { name: 'Upload to support' })).toBeDisabled()
  })

  it('includes Chinese consent and action translations', async () => {
    await i18n.changeLanguage('zh-CN')
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: '上传给支持团队' }))
    expect(await screen.findByText(/日志仍可能包含个人信息/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '同意并上传' })).toBeTruthy()
  })

  it('hides the button behind a quiet note when the server has uploads switched off', async () => {
    upload.mockRejectedValueOnce(Object.assign(new Error('Diagnostic uploads are not configured.'), {
      code: 'diagnostics_unavailable',
    }))
    renderUpload()
    await confirmUpload()
    expect(await screen.findByText(/does not accept diagnostic uploads/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload to support' })).toBeNull()
    // Remembered for the run: a remount does not offer it again.
    cleanup()
    renderUpload()
    expect(screen.queryByRole('button', { name: 'Upload to support' })).toBeNull()
  })

  it('renders the row\'s other actions beside the upload button', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <DiagnosticUpload report={report}><button type="button">Export ZIP</button></DiagnosticUpload>
      </I18nextProvider>,
    )
    const upload = screen.getByRole('button', { name: 'Upload to support' })
    expect(upload.parentElement).toBe(screen.getByRole('button', { name: 'Export ZIP' }).parentElement)
  })
})
