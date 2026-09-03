import { appStoragePrefix } from '@/lib/config/build-config'

const STORAGE_KEY = `${appStoragePrefix}-daemon-onboarding-identity`

type DaemonOnboardingIdentity = {
  teamId: string
  userId: string
}

/**
 * The account which most recently provisioned this machine's daemon. A daemon
 * is single-team, but its Cloud credentials are also owned by a user; teamId
 * alone is therefore insufficient after a phone-linked identity switch.
 */
export function readDaemonOnboardingIdentity(): DaemonOnboardingIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<DaemonOnboardingIdentity>
    if (!value.teamId || !value.userId) return null
    return { teamId: value.teamId, userId: value.userId }
  } catch {
    return null
  }
}

export function writeDaemonOnboardingIdentity(identity: DaemonOnboardingIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Local storage is an optimization. A missing record never prevents the
    // daemon wizard from recovering a machine.
  }
}

export function clearDaemonOnboardingIdentity(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore unavailable local storage */
  }
}
