import { getBackend } from '@/lib/backend'
import { isTauri } from '@/lib/utils'

const cache = new Map<string, Set<string>>()

/**
 * Resolve the set of session ids the given actor participates in.
 * Tauri path: read from local cache first if available. Always falls back to
 * Supabase as source of truth. Results are memoized per process by actorId.
 */
export async function loadSessionIdsForActor(actorId: string, _teamId: string): Promise<Set<string>> {
  const cached = cache.get(actorId)
  if (cached) return cached

  const ids = new Set<string>()

  if (isTauri()) {
    try {
      const localMod = await import('@/lib/cache/local-cache')
      const fn = (localMod as unknown as { loadSessionParticipantsByActor?: (a: string) => Promise<Array<{ sessionId: string }>> }).loadSessionParticipantsByActor
      if (typeof fn === 'function') {
        const rows = await fn(actorId)
        for (const row of rows) ids.add(row.sessionId)
      }
    } catch (e) {
      console.warn('[session-by-actor] local cache lookup failed (non-fatal)', e)
    }
  }

  try {
    const sessionIds = await getBackend().sessionMembers.listSessionIdsForActor(actorId)
    for (const sessionId of sessionIds) ids.add(sessionId)
  } catch (error) {
    console.error('[session-by-actor] supabase lookup failed', error)
  }

  cache.set(actorId, ids)
  return ids
}

/** Test/reset hook — clear the in-memory memo. */
export function clearSessionByActorCache(): void {
  cache.clear()
}
