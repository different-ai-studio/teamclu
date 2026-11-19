/**
 * Compact "time since" for the daemon settings pages (`just now`, `5m ago`,
 * `3h ago`, `2d ago`); `-` when there is no value, the raw string when it does
 * not parse.
 *
 * Hardcoded English, unlike `lib/ui/date-format.ts`. Shared by
 * `DaemonGeneralSection` and `DaemonRuntimesSection`, which used to carry
 * byte-identical copies; moving it onto i18n would change what those pages
 * show, so that is a separate decision.
 */
export function formatRelative(value: string | null, now: number = Date.now()): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return value
  const diff = now - time
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
