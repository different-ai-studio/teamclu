import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'

/**
 * Per-user preferences for the conversation header's right-side action icons.
 *
 * These gate the header panel-tab buttons rendered in `App.tsx` (the "Changes"
 * diff-panel entry and skills refresh). They are *additive* gates: a
 * preference of `true` only *allows* the icon to render — the existing
 * capability/session conditions still apply on top.
 *
 * Defaults are intentionally `false` (icons hidden out of the box) so the
 * conversation header stays quiet.
 *
 * Persistence mirrors `git-settings.ts`: Zustand + a manual localStorage
 * round-trip via `loadFromStorage`/`saveToStorage`, keyed with the shared
 * `appStoragePrefix`.
 */
interface HeaderPreferencesState {
  /** Show the "Changes" (file diff) panel entry in the conversation header. Default false. */
  showChangesTab: boolean
  /** Show the force-refresh-skills icon in the conversation header. Default false. */
  showSkillsRefresh: boolean
  setShowChangesTab: (show: boolean) => void
  setShowSkillsRefresh: (show: boolean) => void
}

const STORAGE_KEY = `${appStoragePrefix}-header-prefs`

const persisted = loadFromStorage<Partial<HeaderPreferencesState>>(STORAGE_KEY, {})

function persist(state: HeaderPreferencesState) {
  saveToStorage(STORAGE_KEY, {
    showChangesTab: state.showChangesTab,
    showSkillsRefresh: state.showSkillsRefresh,
  })
}

export const useHeaderPreferencesStore = create<HeaderPreferencesState>((set, get) => ({
  // Defaults: hidden. `?? false` is belt-and-suspenders — loadFromStorage's
  // fallback is already `{}`, so missing keys read as `undefined` → false.
  showChangesTab: persisted.showChangesTab ?? false,
  showSkillsRefresh: persisted.showSkillsRefresh ?? false,

  setShowChangesTab: (show) => {
    set({ showChangesTab: show })
    persist(get())
  },
  setShowSkillsRefresh: (show) => {
    set({ showSkillsRefresh: show })
    persist(get())
  },
}))
