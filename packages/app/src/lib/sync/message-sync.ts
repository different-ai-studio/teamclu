/**
 * message-sync.ts — Sync messages from the Cloud API into the local libsql cache.
 *
 * Delta-pulled by `updated_at`. Watermark key: "messages:<sessionId>"
 * namespaced by teamId.
 *
 * Rows pulled here carry origin = the backend kind (`"cloud_api"`; rows cached
 * by older builds may still say `"supabase"`). MQTT-live messages are written
 * with origin="mqtt-live" by `components/mqtt-live-wiring/handle-live-message.ts`
 * and `lib/agent/agent-turn-flush.ts`.
 */

import { getBackend } from "@/lib/backend";
import type { BackendKind, MessageSyncRow } from "@/lib/backend/types";
import * as cache from "@/lib/cache/local-cache";
import { isTauri } from "@/lib/utils";

// The Cloud API row carries `metadata` (the jsonb column), not `metadata_json`.
// We stringify it into local libsql's metadata_json TEXT column.
function mapRow(r: MessageSyncRow, origin: BackendKind): cache.MessageRow {
  const metadataJson =
    r.metadata == null
      ? null
      : typeof r.metadata === "string"
        ? r.metadata
        : JSON.stringify(r.metadata);
  return {
    id: r.id,
    teamId: r.team_id,
    sessionId: r.session_id,
    turnId: r.turn_id ?? null,
    senderActorId: r.sender_actor_id ?? null,
    replyToMessageId: r.reply_to_message_id ?? null,
    kind: r.kind,
    content: r.content ?? "",
    metadataJson,
    model: r.model ?? null,
    mentionsJson: null,
    origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: null,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Pull messages for a session from the Cloud API (delta or full),
 * upsert into local cache, bump per-session watermark.
 *
 * @returns number of rows synced
 */
export async function syncMessagesForSession(
  sessionId: string,
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const watermarkKey = `messages:${sessionId}`;
  const watermark = opts?.full
    ? null
    : await cache.getWatermark(watermarkKey, teamId);

  const backend = getBackend();
  let data: MessageSyncRow[];
  try {
    data = await backend.messages.listMessagesForSessionSince(
      sessionId,
      watermark,
    );
  } catch (error) {
    console.warn("[message-sync] pull failed:", error);
    return 0;
  }
  const rows = data.map((row) => mapRow(row, backend.kind));
  if (rows.length > 0) {
    await cache.upsertMessagesBatch(rows);
    const maxUpdated = rows.reduce(
      (acc, row) => (row.updatedAt > acc ? row.updatedAt : acc),
      watermark ?? "",
    );
    if (maxUpdated) {
      await cache.setWatermark(watermarkKey, teamId, maxUpdated);
    }
  }
  return rows.length;
}
