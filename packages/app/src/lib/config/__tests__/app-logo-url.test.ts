import { afterEach, describe, expect, it, vi } from 'vitest'

describe('appLogoUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('uses an absolute path when Vite base is /', async () => {
    vi.stubEnv('BASE_URL', '/')
    const { appLogoUrl } = await import('@/lib/config/app-logo-url')
    expect(appLogoUrl()).toBe('/logo.png')
    expect(appLogoUrl('logo-64.png')).toBe('/logo-64.png')
  })

  it('uses a relative path when Vite base is ./ (extension side panel)', async () => {
    vi.stubEnv('BASE_URL', './')
    const { appLogoUrl } = await import('@/lib/config/app-logo-url')
    expect(appLogoUrl()).toBe('./logo.png')
  })
})
