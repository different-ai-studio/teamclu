import { isTauri } from './utils'

type AppPlatform = 'desktop' | 'extension' | 'web'

type ChromeRuntimeLike = { id?: string }

function readChromeRuntime(): ChromeRuntimeLike | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome
  return chrome?.runtime
}

/** Running inside a Chrome MV3 extension (side panel / content script context). */
export function isChromeExtension(): boolean {
  return Boolean(readChromeRuntime()?.id)
}

export function getAppPlatform(): AppPlatform {
  if (isTauri()) return 'desktop'
  if (isChromeExtension()) return 'extension'
  return 'web'
}

/** Runtime capability flags — prefer these over scattered isTauri() checks. */
export const capabilities = {
  get workspace() {
    return getAppPlatform() === 'desktop'
  },
  get tauriInvoke() {
    return isTauri()
  },
  get pageCapture() {
    return getAppPlatform() === 'extension'
  },
  /**
   * Provider OAuth (Google / WeChat) can capture its redirect. Desktop uses a
   * native loopback listener, the extension uses chrome.identity; plain web has
   * neither, so it stays on email OTP.
   */
  get oauthSignIn() {
    const platform = getAppPlatform()
    return platform === 'desktop' || platform === 'extension'
  },
} as const
