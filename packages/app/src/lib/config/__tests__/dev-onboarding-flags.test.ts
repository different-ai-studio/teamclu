import { afterEach, describe, expect, it, vi } from 'vitest'
import { devSkipDaemonOnboarding, devSkipSetup } from '@/lib/config/dev-onboarding-flags'

describe('dev-onboarding-flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to false when env vars are unset', () => {
    expect(devSkipSetup()).toBe(false)
    expect(devSkipDaemonOnboarding()).toBe(false)
  })

  it('reads VITE_TEAMCLU_SKIP_* from import.meta.env', () => {
    vi.stubEnv('VITE_TEAMCLU_SKIP_SETUP', 'true')
    vi.stubEnv('VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING', 'true')
    expect(devSkipSetup()).toBe(true)
    expect(devSkipDaemonOnboarding()).toBe(true)
  })
})
