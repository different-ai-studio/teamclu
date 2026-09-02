import { appStoragePrefix } from '@/lib/build-config'

const LANGUAGE_STORAGE_KEY = `${appStoragePrefix}-language`
export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number]

export const LANGUAGE_OPTIONS: Array<{
  value: SupportedLanguage
  labelKey: string
  fallback: string
}> = [
  { value: 'en', labelKey: 'common.english', fallback: 'English' },
  { value: 'zh-CN', labelKey: 'common.chinese', fallback: '中文' },
]

export function isSupportedLanguage(language: string | null | undefined): language is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)
}

function getStorage(): Storage | undefined {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }

  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage
  }

  return undefined
}

function getNavigator(): Navigator | undefined {
  if (typeof window !== 'undefined' && window.navigator) {
    return window.navigator
  }

  if (typeof globalThis !== 'undefined' && 'navigator' in globalThis) {
    return globalThis.navigator
  }

  return undefined
}

export function normalizeSupportedLanguage(language: string | null | undefined): string {
  if (!language) return 'en'

  const normalized = language.toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en'
  }
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh-CN'
  }

  return 'en'
}

function getStoredLanguage(): string | null {
  const storage = getStorage()
  if (!storage) return null

  try {
    const language = storage.getItem(LANGUAGE_STORAGE_KEY)
    return language ? normalizeSupportedLanguage(language) : null
  } catch {
    return null
  }
}

export function getSystemLanguage(): string {
  const nav = getNavigator()
  if (!nav) return 'en'

  const candidates = nav.languages?.length ? nav.languages : [nav.language]
  for (const candidate of candidates) {
    const language = normalizeSupportedLanguage(candidate)
    if (language !== 'en' || candidate?.toLowerCase().startsWith('en')) {
      return language
    }
  }

  return 'en'
}

export function getPreferredLanguage(): string {
  // An explicit choice always wins; absent one, follow the system. A machine set
  // to Chinese gets 中文, everything else gets English — matching the OS beats
  // defaulting to English for a user who never asked for it.
  //
  // Only ever a *default*: the first-run language step and the settings switcher
  // both persist a choice, and getStoredLanguage() shadows this from then on.
  return getStoredLanguage() ?? getSystemLanguage()
}

export function persistLanguage(language: string): void {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, normalizeSupportedLanguage(language))
  } catch {
    // Ignore storage failures and continue with in-memory language state.
  }
}
