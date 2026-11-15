import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('fetchAppVersion', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis as Record<string, unknown>, 'chrome')
  })

  it('reports the Chrome extension manifest version when not running in Tauri', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({
      getVersion: async () => {
        throw new Error('not tauri')
      },
    }))
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          getManifest: () => ({ version: '0.2.3' }),
        },
      },
    })

    const { fetchAppVersion, resetAppVersionCacheForTests } = await import('../version')
    resetAppVersionCacheForTests()
    await expect(fetchAppVersion()).resolves.toBe('0.2.3')
  })

  it('does not keep a hardcoded fallback when a different manifest version is loaded', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({
      getVersion: async () => {
        throw new Error('not tauri')
      },
    }))
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          getManifest: () => ({ version: '0.2.4' }),
        },
      },
    })

    const { fetchAppVersion, resetAppVersionCacheForTests } = await import('../version')
    resetAppVersionCacheForTests()
    await expect(fetchAppVersion()).resolves.toBe('0.2.4')
  })

  it('prefers the Tauri app version over the extension manifest', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({
      getVersion: async () => '0.4.1-beta.116',
    }))
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          getManifest: () => ({ version: '0.2.3' }),
        },
      },
    })

    const { fetchAppVersion, resetAppVersionCacheForTests } = await import('../version')
    resetAppVersionCacheForTests()
    await expect(fetchAppVersion()).resolves.toBe('0.4.1-beta.116')
  })
})
