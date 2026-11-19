/**
 * Human-readable byte size (`512 B`, `1.5 KB`, `12 MB`); `null` for a missing
 * size so each caller picks its own placeholder.
 */
export function formatBytes(n: number | null | undefined): string | null {
  if (n == null) return null
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
