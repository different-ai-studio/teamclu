import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNetworkError } from '@/lib/network-error'

describe('isNetworkError', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("recognises each engine's fetch rejection", () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true)
    expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    )
  })

  it('does not claim errors that merely mention a failure', () => {
    expect(isNetworkError(new Error('Skill load failed: missing SKILL.md'))).toBe(false)
    expect(isNetworkError(new Error('Cloud API request failed.'))).toBe(false)
    expect(isNetworkError('boom')).toBe(false)
  })

  it('counts any failure while the machine reports itself offline', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(isNetworkError(new Error('Missing auth session access token.'))).toBe(true)
  })
})
