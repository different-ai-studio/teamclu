/**
 * Function types for helpers that take react-i18next's `t` as an argument.
 *
 * Written as overloads on purpose. i18next 27 types `t` as a union of
 * rest-parameter tuples, and a single signature with an optional trailing
 * parameter (`(key, fallback, vars?) => string`) is no longer assignable from
 * it. Each overload here matches one of those tuples, so the real `t` and a
 * plain test double (`(key, fallback) => fallback`) both fit.
 *
 * A helper that may or may not have interpolation values calls
 * `vars ? t(key, fallback, vars) : t(key, fallback)`.
 */

/** `t(key, fallback)` / `t(key, fallback, vars)`. */
export type TranslateWithFallback = {
  (key: string, fallback: string): string
  (key: string, fallback: string, vars: Record<string, unknown>): string
}

/** `t(key)` / `t(key, options)` — keys that rely on the locale file. */
export type TranslateWithOptions = {
  (key: string): string
  (key: string, options: Record<string, unknown>): string
}
