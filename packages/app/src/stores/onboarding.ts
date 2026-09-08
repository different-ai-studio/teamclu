import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/config/build-config'

/**
 * First-run state that has to be answered before sign-in.
 *
 * Only the language is left (#1250). Picking a runtime and installing it used
 * to live here too; with pi the only runtime there is nothing to pick, and the
 * install moved into the post-login daemon wizard (`stores/daemon-onboarding`)
 * where the daemon's own doctor is the single source of truth — no
 * localStorage handoff, no "setup-ok" cache to go stale.
 */

/** The language step has been answered. Separate from the language itself:
 *  `${appStoragePrefix}-language` records *what* was picked, this records
 *  *that* it was asked, so a user who confirms the system default is not asked
 *  again on the next launch. */
const LANGUAGE_ACK_KEY = `${appStoragePrefix}-onboarding-language-ack`

/** Keys the pre-#1250 wizard persisted; cleared on `reset` so a re-run starts
 *  from nothing, never read. */
const LEGACY_KEYS = [
  `${appStoragePrefix}-onboarding-role`,
  `${appStoragePrefix}-onboarding-done`,
  `${appStoragePrefix}-onboarding-runtime`,
  `${appStoragePrefix}-setup-ok`,
]

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private mode / disabled storage: onboarding still works for this run, it
    // just asks again next launch. Not worth failing the flow over.
  }
}

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

type OnboardingState = {
  /** The language step has been answered at least once. */
  languageAck: boolean
  markLanguageAck: () => void
  /** Test/dev helper — forget everything and run the flow again. */
  reset: () => void
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  languageAck: readFlag(LANGUAGE_ACK_KEY),

  markLanguageAck: () => {
    write(LANGUAGE_ACK_KEY, '1')
    set({ languageAck: true })
  },

  reset: () => {
    write(LANGUAGE_ACK_KEY, null)
    for (const key of LEGACY_KEYS) write(key, null)
    set({ languageAck: false })
  },
}))
