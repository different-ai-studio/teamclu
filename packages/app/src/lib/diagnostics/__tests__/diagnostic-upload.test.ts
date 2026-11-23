import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticReport } from '../diagnostic-report'
import { uploadDiagnosticZip } from '../diagnostic-upload'
const mocks = vi.hoisted(() => ({
  build: vi.fn(), uploadZip: vi.fn(), desktop: true, configured: true,
}))
vi.mock('../diagnostic-report', () => ({ buildDiagnosticZipBytes: mocks.build }))
vi.mock('@/lib/backend', () => ({ getBackend: () => {
  if (!mocks.configured) throw new Error('Cloud API URL is not configured.')
  return { diagnostics: { uploadZip: mocks.uploadZip } }
} }))
vi.mock('@/lib/utils', () => ({ isTauri: () => mocks.desktop }))
const report = { generatedAt: 'test' } as DiagnosticReport
const bytes = new Uint8Array([80, 75, 3, 4, 8])

describe('uploadDiagnosticZip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.desktop = true
    mocks.configured = true
    mocks.build.mockResolvedValue(bytes)
    mocks.uploadZip.mockResolvedValue({ receiptId: 'receipt', expiresAt: 'expiry' })
  })
  it('uploads exactly the local ZIP builder output through authenticated Cloud API', async () => {
    expect(await uploadDiagnosticZip(report)).toEqual({ receiptId: 'receipt', expiresAt: 'expiry' })
    expect(mocks.build).toHaveBeenCalledExactlyOnceWith(report)
    const [blob] = mocks.uploadZip.mock.calls[0]
    expect(blob.type).toBe('application/zip')
    expect(blob.size).toBe(bytes.length)
    // FileReader works in jsdom as well as browsers; compare every byte.
    const content = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob)
    })
    expect(new Uint8Array(content)).toEqual(bytes)
  })
  it('does not upload on native build failure or oversized ZIP', async () => {
    mocks.build.mockRejectedValueOnce(new Error('Native builder failed'))
    await expect(uploadDiagnosticZip(report)).rejects.toThrow('Native builder failed')
    mocks.build.mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1))
    await expect(uploadDiagnosticZip(report)).rejects.toThrow('10 MiB')
    expect(mocks.uploadZip).not.toHaveBeenCalled()
  })
  it('propagates upload errors and rejects unsupported/missing configuration before collecting', async () => {
    mocks.uploadZip.mockRejectedValueOnce(new Error('Upload unavailable'))
    await expect(uploadDiagnosticZip(report)).rejects.toThrow('Upload unavailable')
    mocks.build.mockClear()
    mocks.configured = false
    await expect(uploadDiagnosticZip(report)).rejects.toThrow('not configured')
    mocks.desktop = false
    await expect(uploadDiagnosticZip(report)).rejects.toThrow('Desktop')
    expect(mocks.build).not.toHaveBeenCalled()
  })
})
