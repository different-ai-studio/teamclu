/**
 * session-sync.ts — Sync sessions from Supabase into local libsql cache.
 *
 * updated_at: ✓ present on sessions (confirmed via information_schema)
 * Watermark key: "sessions" namespaced by teamId.
 */

import { getBackend } from "@/lib/backend";
import type { SessionSyncRow } from "@/lib/backend/types";
import * as cache from "@/lib/local-cache";
import { seedSessionCreatedByFromRows } from "@/lib/session-created-by-cache";
import { isTauri } from "@/lib/utils";

// Supabase `sessions` columns: id, team_id, created_by_actor_id, primary_agent_id,
// mode, title, summary, last_message_preview, last_message_at, created_at,
// updated_at, idea_id. (No `created_by`, no `metadata_json`.)
function mapRow(r: SessionSyncRow): cache.SessionRow {
  return {
    id: r.id,
    teamId: r.team_id,
    title: r.title ?? null,
    mode: r.mode ?? null,
    primaryAgentId: r.primary_agent_id ?? null,
    ideaId: r.idea_id ?? null,
    summary: r.summary ?? null,
    lastMessagePreview: r.last_message_preview ?? null,
    lastMessageAt: r.last_message_at ?? null,
    createdBy: r.created_by_actor_id ?? null,
    metadataJson: null,
    source: r.source ?? null,
    cronJobId: r.cron_job_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: null,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Pull sessions for a team from Supabase (delta or full),
 * upsert into local cache, bump watermark.
 *
 * @returns number of rows synced
 */
export async function syncSessionsForTeam(
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const watermark = opts?.full
    ? ""
    : (await cache.getWatermark("sessions", teamId)) ?? "";

  let data: SessionSyncRow[];
  try {
    data = await getBackend().sessions.listSessionsForTeamSince(
      teamId,
      watermark,
    );
  } catch (error) {
    console.warn("[session-sync] pull failed:", error);
    return 0;
  }
  const rows = data.filter((row) => row.archived_at == null).map(mapRow);
  if (rows.length > 0) {
    seedSessionCreatedByFromRows(rows);
    await cache.upsertSessionsBatch(rows);
    const maxUpdated = rows.reduce(
      (acc, row) => (row.updatedAt > acc ? row.updatedAt : acc),
      watermark,
    );
    if (maxUpdated) {
      await cache.setWatermark("sessions", teamId, maxUpdated);
    }
  }
  return rows.length;
}
