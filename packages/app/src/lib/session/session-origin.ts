/**
 * Shared "is this session scheduled-origin?" predicate.
 *
 * A session is scheduled-origin when its persisted `source` says so. The
 * device-local `cronSessionIds` overlay is only an optimistic fallback for a
 * just-created cron session whose list row hasn't synced `source` yet.
 *
 * This lives in one place because the surfaces that split the list into
 * "chat" vs "scheduled" — NavRail's counts, SessionListColumn, SessionList —
 * drifted apart once already: the latter two moved to `source` while NavRail
 * kept counting on the overlay alone, so cron sessions stayed in the 会话
 * badge even after they'd been filtered out of the list itself.
 */
export function isScheduledSession(
  row: { id: string; source?: string | null },
  cronSessionIds: ReadonlySet<string>,
): boolean {
  return row.source === 'cron' || cronSessionIds.has(row.id)
}
