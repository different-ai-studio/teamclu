/**
 * Fingerprint for SessionLiquidGlass resync.
 *
 * The glass pill tracks DOM geometry via getBoundingClientRect. It must
 * re-measure when row *order* or row *height* changes while activeSessionId
 * stays the same (e.g. bumpLastMessage re-sort, activity badge, participants
 * loading). Keep this string compact — it is recomputed on each list render.
 */
export function buildSessionListGlassLayoutKey(input: {
  activeSessionId: string | null | undefined
  actionsOpenSessionId: string | null | undefined
  /** Render order — session ids plus structural keys (pinned header / divider). */
  rowOrder: readonly string[]
  /** Sessions whose participants sub-row affects card height. */
  rowLayoutHints: readonly { sessionId: string; participantCount: number }[]
  shouldVirtualize: boolean
}): string {
  const order = input.rowOrder.join('|')
  let layoutHints = ''
  for (const hint of input.rowLayoutHints) {
    if (hint.participantCount === 0) continue
    layoutHints += `${hint.sessionId}:${hint.participantCount};`
  }
  return [
    input.activeSessionId ?? '',
    input.actionsOpenSessionId ?? '',
    order,
    layoutHints,
    input.shouldVirtualize ? '1' : '0',
  ].join('\0')
}
