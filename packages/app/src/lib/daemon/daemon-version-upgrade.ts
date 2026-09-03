import { isTauri } from '@/lib/utils'

let inFlight: Promise<void> | null = null

/**
 * Previously copied the App-bundled amuxd into ~/.amuxd/bin when the installed
 * copy was older. Desktop-managed mode runs the sidecar directly, so this is a
 * no-op kept for call-site compatibility (`main.tsx`).
 */
export function ensureBundledAmuxdCurrent(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = Promise.resolve().finally(() => {
    inFlight = null
  })
  if (!isTauri()) {
    return inFlight
  }
  return inFlight
}
