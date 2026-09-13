import { beforeEach, describe, expect, test, vi } from 'vitest'
import { loadFromStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'

const STORAGE_KEY = `${appStoragePrefix}-auto-update-pref`

// Migration runs once at module load, so each scenario needs a fresh module
// instance with localStorage seeded beforehand.
describe('auto-update-preference-store', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  test('brand-new install (no stored key) defaults to auto-download', async () => {
    const { useAutoUpdatePreferenceStore } = await import('@/stores/auto-update-preference-store')
    expect(useAutoUpdatePreferenceStore.getState().mode).toBe('auto-download')
    expect(loadFromStorage(STORAGE_KEY, null)).toEqual({ mode: 'auto-download' })
  })

  test('migrates old autoUpdateEnabled=true to auto-download', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ autoUpdateEnabled: true }))
    const { useAutoUpdatePreferenceStore } = await import('@/stores/auto-update-preference-store')
    expect(useAutoUpdatePreferenceStore.getState().mode).toBe('auto-download')
  })

  test('migrates old autoUpdateEnabled=false to manual, never upgrading to auto-restart', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ autoUpdateEnabled: false }))
    const { useAutoUpdatePreferenceStore } = await import('@/stores/auto-update-preference-store')
    expect(useAutoUpdatePreferenceStore.getState().mode).toBe('manual')
  })

  test('preserves an already-migrated tri-state mode as-is', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'auto-restart' }))
    const { useAutoUpdatePreferenceStore } = await import('@/stores/auto-update-preference-store')
    expect(useAutoUpdatePreferenceStore.getState().mode).toBe('auto-restart')
  })

  test('setUpdateMode persists to localStorage', async () => {
    const { useAutoUpdatePreferenceStore } = await import('@/stores/auto-update-preference-store')
    useAutoUpdatePreferenceStore.getState().setUpdateMode('auto-restart')
    expect(useAutoUpdatePreferenceStore.getState().mode).toBe('auto-restart')
    expect(loadFromStorage(STORAGE_KEY, null)).toEqual({ mode: 'auto-restart' })
  })
})
