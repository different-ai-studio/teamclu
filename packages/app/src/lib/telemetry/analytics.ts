/**
 * Dependency-free product-analytics helper. Forwards events to the Rust
 * `telemetry_track` command, which routes them to Aptabase and only emits when
 * the user has granted telemetry consent.
 *
 * This module intentionally imports nothing from the store graph so it can be
 * used from any module (stores, lib helpers) without creating import cycles —
 * `stores/telemetry.ts` already pulls in the session/team stores, so importing
 * *that* from a store would form a cycle.
 */
export async function trackEvent(
  eventName: string,
  props?: Record<string, unknown>,
): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('telemetry_track', { eventName, props: props ?? null })
  } catch {
    // Non-critical — ignore failures (e.g. browser preview, no Tauri runtime).
  }
}
