import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

/**
 * Layout switches kept in a file under the app config dir by the desktop
 * shell (`commands/ui_layout_prefs.rs`), so they survive updates and
 * reinstalls. localStorage keeps a copy too: it is what the UI reads
 * synchronously at startup, and the file corrects it when the two disagree
 * (see `reconcileUiLayoutPrefs`).
 */
export type UiLayoutPrefKey = 'navPinned' | 'sessionDrawerPinned'

export type UiLayoutPrefs = Partial<Record<UiLayoutPrefKey, boolean>>

export function persistUiLayoutPref(key: UiLayoutPrefKey, value: boolean): void {
  if (!isTauri()) return
  void invoke('set_ui_layout_pref', { key, value }).catch((e) => {
    console.warn('[ui-layout-prefs] save failed', key, e)
  })
}

export async function loadUiLayoutPrefs(): Promise<UiLayoutPrefs | null> {
  if (!isTauri()) return null
  try {
    return await invoke<UiLayoutPrefs>('get_ui_layout_prefs')
  } catch (e) {
    console.warn('[ui-layout-prefs] load failed', e)
    return null
  }
}

/**
 * What to do with each key once the file has been read: values the file has
 * win over the in-memory ones (localStorage may have been wiped); keys the
 * file lacks are written to it from memory, which carries a value saved
 * before the file existed over to it.
 */
export function reconcileUiLayoutPrefs(
  file: UiLayoutPrefs,
  current: Record<UiLayoutPrefKey, boolean>,
): { apply: UiLayoutPrefs; backfill: UiLayoutPrefs } {
  const apply: UiLayoutPrefs = {}
  const backfill: UiLayoutPrefs = {}
  for (const key of Object.keys(current) as UiLayoutPrefKey[]) {
    const stored = file[key]
    if (typeof stored !== 'boolean') backfill[key] = current[key]
    else if (stored !== current[key]) apply[key] = stored
  }
  return { apply, backfill }
}
