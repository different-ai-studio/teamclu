import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticsModule } from '../diagnostics'
import type { CloudApiClient } from '../http'

describe('Cloud API diagnostics provider', () => {
  it('sends the exact ZIP body through the shared authenticated binary client', async () => {
    const receipt = { receiptId: 'receipt-id', expiresAt: '2026-11-22T12:00:00Z' }
    const postRaw = vi.fn().mockResolvedValue(receipt)
    const api = createDiagnosticsModule({ postRaw } as unknown as CloudApiClient)
    const body = new Blob(['zip-bytes'], { type: 'application/zip' })
    expect(await api.uploadZip(body)).toEqual(receipt)
    expect(postRaw).toHaveBeenCalledExactlyOnceWith('/v1/diagnostics', body, { contentType: 'application/zip' })
  })
  it('propagates auth, storage and network errors to the consent UI', async () => {
    const postRaw = vi.fn().mockRejectedValue(new Error('Upload rejected'))
    const api = createDiagnosticsModule({ postRaw } as unknown as CloudApiClient)
    await expect(api.uploadZip(new Blob())).rejects.toThrow('Upload rejected')
  })
})
