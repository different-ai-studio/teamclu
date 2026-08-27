/**
 * Session-scoped pending permission registry for claude-bridge.
 * Pending approvals belong to the session that created them; closing one
 * session must not deny another session's in-flight approvals.
 */

/** @typedef {{ sessionKey: string, settle: (result: unknown) => void, input: unknown }} PendingPermission */

/**
 * @param {Map<string, PendingPermission>} pending
 * @param {string} sessionKey
 * @param {(entry: PendingPermission) => unknown} result
 */
export function settlePermissionsForSession(pending, sessionKey, result) {
  for (const [requestId, entry] of pending) {
    if (entry.sessionKey !== sessionKey) continue
    pending.delete(requestId)
    entry.settle(result)
  }
}

/**
 * @param {Map<string, PendingPermission>} pending
 */
export function settleAllPermissions(pending, result) {
  for (const [requestId, entry] of [...pending]) {
    pending.delete(requestId)
    entry.settle(result)
  }
}
