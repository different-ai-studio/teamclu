import { beforeEach, describe, expect, test } from 'vitest'
import { useAutoUpdatePreferenceStore } from '@/stores/auto-update-preference-store'
import { loadFromStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'

const STORAGE_KEY = `${appStoragePrefix}-auto-update-pref`

describe('auto-update-preference-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useAutoUpdatePreferenceStore.setState({ autoUpdateEnabled: false })
  })

  test('defaults to off', () => {
    expect(useAutoUpdatePreferenceStore.getState().autoUpdateEnabled).toBe(false)
  })

  test('setAutoUpdateEnabled persists to localStorage', () => {
    useAutoUpdatePreferenceStore.getState().setAutoUpdateEnabled(true)
    expect(useAutoUpdatePreferenceStore.getState().autoUpdateEnabled).toBe(true)
    expect(loadFromStorage(STORAGE_KEY, null)).toEqual({ autoUpdateEnabled: true })
  })
})
