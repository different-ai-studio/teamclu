import { getBackend } from '@/lib/backend'
import { loadSessionIdsForActor as loadCachedSessionIdsForActor } from '@/lib/cache/local-cache'

/**
 * How long a server answer is reused. The memo exists so switching between
 * actor filters does not refetch each time, not to be a source of truth: an
 * entry that lived for the whole process hid every session the actor joined
 * after the first look.
 */
const MEMO_TTL_MS = 30_000

const memo = new Map<string, { ids: Set<string>; at: number }>()

/**
 * Resolve the set of session ids the given actor participates in.
 *
 * The Cloud API is the source of truth. The desktop's local cache is unioned
 * in so the filter still shows something offline. Only a server answer is
 * memoized: caching the result of a failed request pinned an empty (or
 * cache-only) list until the app restarted.
 */
export async function loadSessionIdsForActor(actorId: string, teamId: string): Promise<Set<string>> {
  const key = `${teamId}::${actorId}`
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.ids

  const ids = new Set<string>()

  try {
    // No-op (empty list) outside Tauri or without a team id.
    for (const sessionId of await loadCachedSessionIdsForActor(teamId, actorId)) ids.add(sessionId)
  } catch (e) {
    console.warn('[session-by-actor] local cache lookup failed (non-fatal)', e)
  }

  try {
    const sessionIds = await getBackend().sessionMembers.listSessionIdsForActor(actorId)
    for (const sessionId of sessionIds) ids.add(sessionId)
    memo.set(key, { ids, at: Date.now() })
  } catch (error) {
    console.error('[session-by-actor] Cloud API lookup failed', error)
  }

  return ids
}

/** Test/reset hook — clear the in-memory memo. */
export function clearSessionByActorCache(): void {
  memo.clear()
}
