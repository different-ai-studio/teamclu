import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'

/**
 * User preference for background update checks (startup + periodic).
 *
 * Default is off — users opt in via Settings → General. Manual "Check for
 * updates" in the settings footer still works regardless of this flag.
 */
interface AutoUpdatePreferenceState {
  autoUpdateEnabled: boolean
  setAutoUpdateEnabled: (enabled: boolean) => void
}

const STORAGE_KEY = `${appStoragePrefix}-auto-update-pref`

const persisted = loadFromStorage<Partial<AutoUpdatePreferenceState>>(STORAGE_KEY, {})

function persist(state: AutoUpdatePreferenceState) {
  saveToStorage(STORAGE_KEY, { autoUpdateEnabled: state.autoUpdateEnabled })
}

export const useAutoUpdatePreferenceStore = create<AutoUpdatePreferenceState>((set, get) => ({
  autoUpdateEnabled: persisted.autoUpdateEnabled ?? false,

  setAutoUpdateEnabled: (enabled) => {
    set({ autoUpdateEnabled: enabled })
    persist(get())
  },
}))
