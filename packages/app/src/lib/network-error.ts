/**
 * True when a request never reached the server: no network, DNS failure,
 * connection refused.
 *
 * `fetch` rejects with a bare TypeError whose message depends on the engine —
 * "Failed to fetch" (Chromium / WebView2), "Load failed" (WebKit, which the
 * macOS app runs on), "NetworkError when attempting to fetch resource."
 * (Firefox). None of them tells a user anything. While the OS reports the
 * machine offline every failure counts: a token that cannot be refreshed
 * surfaces as an auth error, but the network is still the cause.
 *
 * No imports on purpose. Component tests mock `react-i18next`, and a helper
 * that dragged in `@/lib/i18n` (which runs `initReactI18next` on load) would
 * break every test of every component that uses it.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const raw = (err instanceof Error ? err.message : String(err)).trim()
  return /^(failed to fetch|load failed|networkerror when attempting to fetch resource\.?)$/i.test(raw)
}
