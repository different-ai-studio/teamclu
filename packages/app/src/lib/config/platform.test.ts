import { afterEach, describe, expect, it, vi } from 'vitest'

describe('platform', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('detects extension when chrome.runtime.id is set', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'abc123' } })
    const { getAppPlatform, isChromeExtension, capabilities } = await import('@/lib/config/platform')
    expect(isChromeExtension()).toBe(true)
    expect(getAppPlatform()).toBe('extension')
    expect(capabilities.workspace).toBe(false)
    expect(capabilities.pageCapture).toBe(true)
  })

  it('detects web when chrome is absent', async () => {
    const { getAppPlatform, capabilities } = await import('@/lib/config/platform')
    expect(getAppPlatform()).toBe('web')
    expect(capabilities.workspace).toBe(false)
    expect(capabilities.pageCapture).toBe(false)
  })
})
