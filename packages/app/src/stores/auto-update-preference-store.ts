import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'

/**
 * User preference for how updates are applied:
 *  - manual: no background checks; only the settings-footer "Check for updates" works
 *  - auto-download: background checks + silent download/install, user clicks Restart
 *  - auto-restart: same as auto-download, but restarts on its own once it finds a
 *    safe window (no active stream/cron/terminal), or after a 24h ceiling
 */
export type UpdateMode = 'manual' | 'auto-download' | 'auto-restart'

interface AutoUpdatePreferenceState {
  mode: UpdateMode
  setUpdateMode: (mode: UpdateMode) => void
}

const STORAGE_KEY = `${appStoragePrefix}-auto-update-pref`

interface PersistedShape {
  mode?: UpdateMode
  /** Pre-tri-state value. Migrated once below, never written again. */
  autoUpdateEnabled?: boolean
}

function isUpdateMode(value: unknown): value is UpdateMode {
  return value === 'manual' || value === 'auto-download' || value === 'auto-restart'
}

/**
 * One-time migration from the old boolean to the new tri-state mode.
 *  - A valid `mode` already on disk wins as-is.
 *  - An old explicit boolean maps 1:1 (true → auto-download, false → manual) —
 *    never silently upgraded into auto-restart.
 *  - No stored key at all (brand-new install) defaults to auto-download.
 */
function resolveInitialMode(persisted: PersistedShape): UpdateMode {
  if (isUpdateMode(persisted.mode)) return persisted.mode
  if (typeof persisted.autoUpdateEnabled === 'boolean') {
    return persisted.autoUpdateEnabled ? 'auto-download' : 'manual'
  }
  return 'auto-download'
}

const persisted = loadFromStorage<PersistedShape>(STORAGE_KEY, {})
const initialMode = resolveInitialMode(persisted)

function persist(mode: UpdateMode) {
  saveToStorage(STORAGE_KEY, { mode })
}

// Normalize storage immediately so the old `autoUpdateEnabled` shape never
// has to be re-read after this module loads once.
persist(initialMode)

export const useAutoUpdatePreferenceStore = create<AutoUpdatePreferenceState>((set) => ({
  mode: initialMode,

  setUpdateMode: (mode) => {
    set({ mode })
    persist(mode)
  },
}))
