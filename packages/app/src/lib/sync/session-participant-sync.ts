/**
 * session-participant-sync.ts — Replace one session's cached roster with the
 * cloud snapshot.
 *
 * The cloud list is the roster. A successful pull of the whole session
 * deletes that session's local rows and inserts the returned ones. A failed
 * or truncated pull leaves the cache alone. There is no delta and no
 * comparison of row ids or updated_at: session create still writes a
 * temporary `sessionId:actorId` row, and the next successful snapshot
 * replaces it.
 */

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
 * Pull the full participant list for a session and replace the local rows.
 *
 * @returns number of cloud rows written, or 0 when the pull did not complete
 */
export async function syncParticipantsForSession(
  sessionId: string,
  teamId: string,
): Promise<number> {
  if (!isTauri()) return 0;
  const generation = await cache.beginSessionParticipantReplace(sessionId);
  let data: SessionParticipantSyncRow[];
  try {
    // `null` asks for the whole session, not a delta since a watermark.
    data = await getBackend().sync.listSessionParticipantsForSync(sessionId, null);
  } catch (error) {
    console.warn(
      `[session-participants] ${teamId}/${sessionId} pull failed:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
  const rows = (data ?? []).map(mapRow);
  await cache.replaceSessionParticipants(sessionId, teamId, generation, rows);
  return rows.length;
}
