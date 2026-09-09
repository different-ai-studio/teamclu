import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

/** The trigger's `getBoundingClientRect()` — where the OS sheet is anchored. */
export interface ShareAnchor {
  x: number
  y: number
  width: number
  height: number
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator.platform ?? '').toLowerCase()
  const ua = (navigator.userAgent ?? '').toLowerCase()
  return platform.includes('mac') || platform.includes('darwin') || ua.includes('mac os')
}

/**
 * Whether a "share to the OS" entry should be offered at all.
 *
 * In the desktop app that is macOS only — `system_share_text` is backed by
 * `NSSharingServicePicker`, and Windows' equivalent isn't wired up. Outside
 * Tauri (browser preview) the Web Share API stands in where the browser has it.
 */
export function canSystemShare(): boolean {
  if (isTauri()) return isMacPlatform()
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/** Hand `text` to the OS share sheet. Rejects if no sheet could be shown. */
export async function systemShareText(text: string, anchor?: ShareAnchor): Promise<void> {
  if (isTauri()) {
    await invoke('system_share_text', { text, anchor: anchor ?? null })
    return
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    await navigator.share({ text })
    return
  }
  throw new Error('system share is unavailable')
}

/**
 * True when the failure is just the user backing out of the sheet.
 *
 * `navigator.share` rejects with `AbortError` on cancel, which is not a
 * failure worth a toast.
 */
export function isShareCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
