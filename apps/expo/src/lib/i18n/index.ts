import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../locales/en.json";
import zhCN from "../../locales/zh-CN.json";
import { getSystemLanguage, type SupportedLanguage } from "./locale";

const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: getSystemLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    // Catalog keys are English UI sentences, some with dots / colons.
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
  });
}

export default i18n;

/**
 * `t(key)` / `t(key, options)`, for helpers that take react-i18next's `t` as
 * an argument. Written as overloads on purpose: i18next 27 types `t` as a
 * union of rest-parameter tuples, and a single signature with an optional
 * `options?` is no longer assignable from it. Each overload matches one of
 * those tuples, so the real `t` and a plain test double both fit. (Desktop has
 * the same type in `packages/app/src/lib/translate-fn.ts`.)
 */
export type TranslateWithOptions = {
  (key: string): string;
  (key: string, options: Record<string, unknown>): string;
};

export function t(key: string, options?: Record<string, unknown>): string {
  // i18next 27 no longer accepts `undefined` as the options argument.
  return options ? i18n.t(key, options) : i18n.t(key);
}

export function getCurrentLanguage(): SupportedLanguage {
  const lng = i18n.language;
  return lng === "zh-CN" ? "zh-CN" : "en";
}
