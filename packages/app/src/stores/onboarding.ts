import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/config/build-config'
import type { DaemonLocalAgent } from '@/lib/daemon/daemon-local-client'

/**
 * How much of the setup the user wants to drive themselves (#881).
 *
 * `developer` — pick the agent runtime, see git and the rest of the dependency
 *   detail, configure models later in Settings.
 * `guided` — take the recommended runtime and skip anything optional.
 *
 * Named for what the user is doing, not for how skilled we think they are:
 * these values reach log lines and telemetry, and "novice" is not a label to
 * attach to somebody.
 */
export type OnboardingRole = 'developer' | 'guided'

const ROLE_KEY = `${appStoragePrefix}-onboarding-role`
const DONE_KEY = `${appStoragePrefix}-onboarding-done`
/** The language step has been answered. Separate from the language itself:
 *  `${appStoragePrefix}-language` records *what* was picked, this records
 *  *that* it was asked, so a user who confirms the system default is not asked
 *  again on the next launch. */
const LANGUAGE_ACK_KEY = `${appStoragePrefix}-onboarding-language-ack`
/**
 * The runtime picked on the setup step, waiting to be written into the daemon.
 *
 * `agents.local_agent` is team-scoped, and the wizard asks before sign-in —
 * there is no team to write the answer to yet. So it waits here until the
 * machine's agent is bound, at which point `stores/daemon-onboarding.ts`
 * applies it and clears this key. A *pending* pick, never a mirror: the daemon
 * stays the authority for what the runtime is, and this exists only to carry
 * the answer across the gap between being asked and there being somewhere to
 * put it. Without it the answer was simply dropped — nothing outside Settings
 * ever wrote the key, so picking pi left you on the daemon default.
 */
const RUNTIME_KEY = `${appStoragePrefix}-onboarding-runtime`
const RUNTIMES = ['opencode', 'pi', 'cursor', 'claude-code'] as const

function readStored<T extends string>(key: string, valid: readonly T[]): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw && (valid as readonly string[]).includes(raw) ? (raw as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private mode / disabled storage: onboarding still works for this run, it
    // just asks again next launch. Not worth failing the flow over.
  }
}

type OnboardingState = {
  /** The language step has been answered at least once. */
  languageAck: boolean
  role: OnboardingRole | null
  /** Runtime chosen on the setup step; null until the user gets there. */
  runtime: DaemonLocalAgent | null
  /** The whole first-run flow has been completed at least once. */
  completed: boolean
  markLanguageAck: () => void
  /** True once the user has answered anything at all. Distinguishes "mid-flow,
   *  came back" from "never started", which decide different things. */
  started: () => boolean
  setRole: (role: OnboardingRole) => void
  setRuntime: (runtime: DaemonLocalAgent) => void
  /** Drop the pending pick, once it has been applied (or given up on). */
  clearRuntime: () => void
  markCompleted: () => void
  /** Test/dev helper — forget everything and run the flow again. */
  reset: () => void
}

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  languageAck: readFlag(LANGUAGE_ACK_KEY),
  role: readStored<OnboardingRole>(ROLE_KEY, ['developer', 'guided']),
  // Restored so a quit between the setup step and sign-in does not lose the
  // answer — that whole stretch is before the pick has anywhere to go.
  runtime: readStored<DaemonLocalAgent>(RUNTIME_KEY, RUNTIMES),
  completed: readFlag(DONE_KEY),

  markLanguageAck: () => {
    write(LANGUAGE_ACK_KEY, '1')
    set({ languageAck: true })
  },

  started: () => {
    const s = get()
    return s.languageAck || s.role !== null
  },

  setRole: (role) => {
    write(ROLE_KEY, role)
    set({ role })
  },

  // Persisted as a pending pick only — see RUNTIME_KEY. The daemon remains the
  // authority for what the runtime *is*; this records what the user asked for
  // before there was anywhere to write it.
  setRuntime: (runtime) => {
    write(RUNTIME_KEY, runtime)
    set({ runtime })
  },

  clearRuntime: () => {
    write(RUNTIME_KEY, null)
    set({ runtime: null })
  },

  markCompleted: () => {
    write(DONE_KEY, '1')
    set({ completed: true })
  },

  reset: () => {
    write(ROLE_KEY, null)
    write(DONE_KEY, null)
    write(LANGUAGE_ACK_KEY, null)
    write(RUNTIME_KEY, null)
    set({ languageAck: false, role: null, runtime: null, completed: false })
  },
}))
