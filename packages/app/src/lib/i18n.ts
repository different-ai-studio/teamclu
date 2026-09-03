import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getPreferredLanguage, isSupportedLanguage, normalizeSupportedLanguage, persistLanguage } from '@/lib/locale';

// Build-time locale selection via VITE_LOCALE env var:
//   undefined or 'all' → both languages (default)
//   'en'               → English only
//   'zh-CN'            → Chinese only
const FORCED_LOCALE = import.meta.env.VITE_LOCALE as string | undefined;
const forcedSupportedLocale =
  FORCED_LOCALE && FORCED_LOCALE !== 'all' && isSupportedLanguage(FORCED_LOCALE)
    ? FORCED_LOCALE
    : undefined;

// PERF-15 — one locale in the startup chunk, not two.
//
// Both catalogues used to be static imports: 277 KB (92 KB gzip) parsed on
// every launch so that roughly half of it could sit unread for the life of the
// process. They are dynamic imports now, and only the language actually in use
// is fetched. Rollup gives each one its own chunk.
//
// The load is awaited before the first React render (`i18nReady`, awaited in
// `main.tsx` and `vitest-setup.ts`) rather than resolved in the background:
// mounting first and filling in the strings after is exactly the flash of
// English a 中文 user must not see. The skeleton in `index.html` is already on
// screen while this settles, so the wait costs no blank frame.
//
// No cross-locale fallback: `__tests__/i18n-parity.test.ts` asserts en and
// zh-CN define exactly the same keys, so a key present in one is present in
// the other and there is nothing for a fallback catalogue to supply.
const catalogues: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('../locales/en.json'),
  'zh-CN': () => import('../locales/zh-CN.json'),
};

/** Locales this build can actually switch to — i.e. has a catalogue for. */
export const availableLanguages: string[] = forcedSupportedLocale
  ? [forcedSupportedLocale]
  : Object.keys(catalogues);

const getUserLanguage = (): string => {
  if (forcedSupportedLocale) {
    return forcedSupportedLocale;
  }

  return normalizeSupportedLanguage(getPreferredLanguage());
};

const initialLanguage = getUserLanguage();

i18n
  .use(initReactI18next) // Passes i18n down to react-i18next
  .init({
    resources: {},
    lng: initialLanguage, // Set the initial language
    // Self-referential on purpose: with parity enforced there is no second
    // catalogue to fall back to, and naming one would load a whole locale to
    // answer lookups that never miss.
    fallbackLng: initialLanguage,
    interpolation: {
      escapeValue: false // React already escapes values
    },
    keySeparator: '.' // Enable nested key lookup (e.g., 'common.save' → common → save)
  });

const loaded = new Set<string>();

/** Fetch a locale's catalogue once and register it with i18next. */
async function loadCatalogue(language: string): Promise<void> {
  if (loaded.has(language)) return;
  const load = catalogues[language];
  if (!load) return;
  const { default: translation } = await load();
  i18n.addResourceBundle(language, 'translation', translation, true, true);
  loaded.add(language);
}

/**
 * Resolves once the startup language's strings are in place.
 *
 * Await this before rendering. Everything that reads a translation before it
 * settles gets the inline default passed to `t()`, or the key.
 */
export const i18nReady: Promise<void> = loadCatalogue(initialLanguage).catch((err) => {
  // A failed catalogue fetch must not take the app down with it — `t()` falls
  // back to the inline defaults, which is degraded but usable.
  console.error('[i18n] failed to load locale', initialLanguage, err);
});

export default i18n;

// Export utility functions for language switching and persistence
export const changeLanguage = async (lang: string): Promise<void> => {
  const normalizedLang = normalizeSupportedLanguage(lang);
  persistLanguage(normalizedLang);

  if (!availableLanguages.includes(normalizedLang)) return;
  // The catalogue has to be in place before the switch, or the first render
  // after `changeLanguage` paints keys.
  await loadCatalogue(normalizedLang);
  await i18n.changeLanguage(normalizedLang);
};

export const getCurrentLanguage = () => {
  return i18n.language;
};

/**
 * True when this build ships a single locale (`VITE_LOCALE=en` / `zh-CN`).
 *
 * Onboarding uses this to hide its language switcher: offering a choice that
 * has exactly one option is noise, and switching would silently no-op because
 * `changeLanguage` only applies languages present in `availableLanguages`.
 */
export const isLocaleLocked = Boolean(forcedSupportedLocale);
