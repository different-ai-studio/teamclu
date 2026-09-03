import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/storage'
import { appStoragePrefix } from '@/lib/build-config'

/**
 * Per-user preferences for the conversation header's right-side action icons.
 *
 * These gate the header panel-tab buttons rendered in `App.tsx` (the terminal
 * toggle and the "Changes" diff-panel entry). They are *additive* gates: a
 * preference of `true` only *allows* the icon to render — the existing
 * capability/session conditions still apply on top.
 *
 * Defaults are intentionally `false` (icons hidden out of the box) so the
 * conversation header stays quiet. The terminal keyboard shortcut (Ctrl+`)
 * keeps working regardless, because hiding the icon only removes the visible
 * entry affordance — the terminal panel itself is owned by `terminal-store`.
 *
 * Persistence mirrors `git-settings.ts`: Zustand + a manual localStorage
 * round-trip via `loadFromStorage`/`saveToStorage`, keyed with the shared
 * `appStoragePrefix`.
 */
interface HeaderPreferencesState {
  /** Show the terminal toggle icon in the conversation header. Default false. */
  showTerminalToggle: boolean
  /** Show the "Changes" (file diff) panel entry in the conversation header. Default false. */
  showChangesTab: boolean
  setShowTerminalToggle: (show: boolean) => void
  setShowChangesTab: (show: boolean) => void
}

const STORAGE_KEY = `${appStoragePrefix}-header-prefs`

const persisted = loadFromStorage<Partial<HeaderPreferencesState>>(STORAGE_KEY, {})

function persist(state: HeaderPreferencesState) {
  saveToStorage(STORAGE_KEY, {
    showTerminalToggle: state.showTerminalToggle,
    showChangesTab: state.showChangesTab,
  })
}

export const useHeaderPreferencesStore = create<HeaderPreferencesState>((set, get) => ({
  // Defaults: hidden. `?? false` is belt-and-suspenders — loadFromStorage's
  // fallback is already `{}`, so missing keys read as `undefined` → false.
  showTerminalToggle: persisted.showTerminalToggle ?? false,
  showChangesTab: persisted.showChangesTab ?? false,

  setShowTerminalToggle: (show) => {
    set({ showTerminalToggle: show })
    persist(get())
  },
  setShowChangesTab: (show) => {
    set({ showChangesTab: show })
    persist(get())
  },
}))
