/** Windows paths use `\`, POSIX uses `/`; both appear in this app's data. */
const SEPARATOR = /[\\/]+/

function splitPath(path: string): { segments: string[]; separator: string } {
  const segments = path.split(SEPARATOR).filter(Boolean)
  return { segments, separator: path.includes('\\') ? '\\' : '/' }
}

/** Last path segment, for naming a workspace after the folder the user picked. */
export function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const { segments } = splitPath(trimmed)
  return segments[segments.length - 1] || trimmed
}

/**
 * Shorten a filesystem path for display by dropping leading segments.
 *
 * The tail is the half that identifies a path: three sibling checkouts under
 * the same parent differ only in their last segment, so CSS `truncate` — which
 * cuts the end — turns them into the same string. The obvious fix,
 * `dir="rtl"`, is worse than it looks: bidi treats `/` as neutral, so the
 * leading slash of an absolute path is reordered to the visual end and
 * `/Volumes/x` renders as `Volumes/x/`.
 *
 * Always pair the result with the full path in a `title`.
 */
export function shortenWorkspacePath(path: string, maxLength = 42): string {
  const trimmed = path.trim()
  if (trimmed.length <= maxLength) return trimmed

  const { segments, separator } = splitPath(trimmed)
  // Grow from the tail while it still fits, but never return fewer than the
  // last segment — a basename longer than maxLength is shown in full rather
  // than cut into something that names nothing.
  let kept = segments.slice(-1)
  for (let i = 2; i <= segments.length; i += 1) {
    const candidate = segments.slice(-i)
    if (`…${separator}${candidate.join(separator)}`.length > maxLength) break
    kept = candidate
  }
  return kept.length === segments.length
    ? trimmed
    : `…${separator}${kept.join(separator)}`
}
