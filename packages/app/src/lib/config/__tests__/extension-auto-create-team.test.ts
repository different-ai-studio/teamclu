import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isExtensionAutoCreateTeamEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.doUnmock('@/lib/config/build-config')
  })

  it('is true outside extension embed builds even when autoCreateTeam is off', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', undefined)
    vi.doMock('@/lib/config/build-config', () => ({
      extensionTeamOnboarding: { autoCreateTeam: false, noTeamMessage: {} },
    }))
    const { isExtensionAutoCreateTeamEnabled } = await import('@/lib/config/extension-auto-create-team')
    expect(isExtensionAutoCreateTeamEnabled()).toBe(true)
  })

  it('follows extensions.teamOnboarding.autoCreateTeam in extension embed builds', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', 'chat')
    vi.doMock('@/lib/config/build-config', () => ({
      extensionTeamOnboarding: { autoCreateTeam: false, noTeamMessage: {} },
    }))
    const { isExtensionAutoCreateTeamEnabled } = await import('@/lib/config/extension-auto-create-team')
    expect(isExtensionAutoCreateTeamEnabled()).toBe(false)
  })
})
