import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearDaemonOnboardingIdentity,
  readDaemonOnboardingIdentity,
  writeDaemonOnboardingIdentity,
} from '@/lib/daemon/daemon-onboarding-identity'

describe('daemon onboarding identity', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips the team and user that provisioned the daemon', () => {
    writeDaemonOnboardingIdentity({ teamId: 'team-1', userId: 'user-1' })
    expect(readDaemonOnboardingIdentity()).toEqual({ teamId: 'team-1', userId: 'user-1' })
  })

  it('clears a binding after a daemon reset', () => {
    writeDaemonOnboardingIdentity({ teamId: 'team-1', userId: 'user-1' })
    clearDaemonOnboardingIdentity()
    expect(readDaemonOnboardingIdentity()).toBeNull()
  })
})
