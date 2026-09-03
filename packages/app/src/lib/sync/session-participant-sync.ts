/**
 * session-participant-sync.ts — Sync session_participants from Supabase into
 * local libsql cache.
 *
 * updated_at: ✓ present on session_participants (confirmed via information_schema)
 * NOTE: session_participants has NO team_id column on Supabase — it is scoped
 * by session_id only. We use syncTableForSession which keys the watermark as
 * "session_participants:<sessionId>" namespaced by teamId.
 */

import { syncTableForSession } from "@/lib/cache/cache-sync";
import { getBackend } from "@/lib/backend";
import * as cache from "@/lib/cache/local-cache";
import { isTauri } from "@/lib/utils";
import type { SessionParticipantSyncRow } from "@/lib/backend/types";

function mapRow(r: SessionParticipantSyncRow): cache.SessionParticipantRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    actorId: r.actor_id,
    joinedAt: r.joined_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: null,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Pull session_participants for a session from Supabase (delta or full),
 * upsert into local cache, bump per-session watermark.
 *
 * @returns number of rows synced
 */
export async function syncParticipantsForSession(
  sessionId: string,
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const { count } = await syncTableForSession<
    SessionParticipantSyncRow,
    cache.SessionParticipantRow
  >({
    watermarkKey: "session_participants",
    sessionId,
    teamId,
    pullRows: (updatedAfter) => getBackend().sync.listSessionParticipantsForSync(sessionId, updatedAfter),
    mapRow,
    upsertBatch: cache.upsertSessionParticipantsBatch,
    full: opts?.full,
    // Removing a participant is a hard DELETE server-side
    // (supabase-repo `removeSessionParticipant`), so the row simply stops
    // appearing — a delta sync has nothing to carry and even a full sync used
    // to only upsert what survived. The removed actor stayed in the cache and
    // came back the next time the session was opened. A full sync is the one
    // moment we hold the server's complete answer, so make it authoritative.
    //
    // MQTT `participant.removed` already routes through `refreshSession`, which
    // syncs with `full: true` — so this also propagates removals made on
    // another device.
    reconcileFull: async (rows) => {
      const stillPresent = new Set(rows.map((row) => row.id));
      const local = await cache.loadSessionParticipants(sessionId);
      const gone = local.filter((row) => !stillPresent.has(row.id));
      if (gone.length === 0) return;
      const deletedAt = new Date().toISOString();
      await Promise.all(
        gone.map((row) => cache.softDeleteSessionParticipant(row.id, deletedAt)),
      );
    },
  });
  return count;
}
