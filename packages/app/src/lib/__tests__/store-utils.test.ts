import { describe, it, expect, vi } from 'vitest'
import { withAsync } from '@/lib/store-utils'

describe('withAsync', () => {
  it('sets loading true then false on success', async () => {
    const set = vi.fn()
    await withAsync(set, async () => 'result')
    expect(set).toHaveBeenCalledWith({ isLoading: true, error: null })
    expect(set).toHaveBeenCalledWith({ isLoading: false })
  })

  it('returns the result of fn', async () => {
    const set = vi.fn()
    const result = await withAsync(set, async () => 42)
    expect(result).toBe(42)
  })

  it('sets error on failure and returns undefined', async () => {
    const set = vi.fn()
    const result = await withAsync(set, async () => {
      throw new Error('boom')
    })
    expect(result).toBeUndefined()
    expect(set).toHaveBeenCalledWith({ error: 'boom', isLoading: false })
  })

  it('rethrows when rethrow option is true', async () => {
    const set = vi.fn()
    await expect(
      withAsync(set, async () => { throw new Error('boom') }, { rethrow: true })
    ).rejects.toThrow('boom')
  })

  it('uses custom loadingKey and errorKey', async () => {
    const set = vi.fn()
    await withAsync(set, async () => 'ok', {
      loadingKey: 'isLoadingDocuments',
      errorKey: 'documentError',
    })
    expect(set).toHaveBeenCalledWith({ isLoadingDocuments: true, documentError: null })
    expect(set).toHaveBeenCalledWith({ isLoadingDocuments: false })
  })

  it('handles non-Error thrown values', async () => {
    const set = vi.fn()
    await withAsync(set, async () => {
      throw 'string error'
    })
    expect(set).toHaveBeenCalledWith({ error: 'string error', isLoading: false })
  })
})
