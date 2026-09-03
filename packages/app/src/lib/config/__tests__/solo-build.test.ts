import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isSoloBuild', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.doUnmock('@/lib/config/build-config')
  })

  it('is false outside extension embed builds even when solo is on', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', undefined)
    vi.doMock('@/lib/config/build-config', () => ({
      extensionSoloBuild: true,
    }))
    const { isSoloBuild } = await import('@/lib/config/solo-build')
    expect(isSoloBuild()).toBe(false)
  })

  it('follows extensions.solo in extension embed builds', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', 'chat')
    vi.doMock('@/lib/config/build-config', () => ({
      extensionSoloBuild: true,
    }))
    const { isSoloBuild } = await import('@/lib/config/solo-build')
    expect(isSoloBuild()).toBe(true)
  })

  it('is false when extensions.solo is off', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', 'chat')
    vi.doMock('@/lib/config/build-config', () => ({
      extensionSoloBuild: false,
    }))
    const { isSoloBuild } = await import('@/lib/config/solo-build')
    expect(isSoloBuild()).toBe(false)
  })
})
