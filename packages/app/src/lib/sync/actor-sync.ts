/**
 * actor-sync.ts — Sync actor_directory from Supabase into local libsql cache.
 *
 * Uses the `actor_directory` view (joined view the frontend already queries)
 * because it exposes actor_type, display_name, member_status, agent_status,
 * and avatar_url in one SELECT.
 *
 * updated_at: ✓ present on actor_directory (confirmed via information_schema)
 */

import { getBackend } from "@/lib/backend";
import type { ActorDirectorySyncRow } from "@/lib/backend/types";
import * as cache from "@/lib/cache/local-cache";
import { isTauri } from "@/lib/utils";
import { notifyActorDirectorySynced } from "@/stores/actor-directory-store";

function mapRow(r: ActorDirectorySyncRow): cache.ActorRow {
  return {
    id: r.id,
    teamId: r.team_id,
    actorType: r.actor_type,
    displayName: r.display_name,
    avatarUrl: null,
    memberStatus: r.member_status ?? null,
    agentStatus: r.agent_status ?? null,
    lastActiveAt: r.last_active_at ?? null,
    metadataJson: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: null,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Pull actor_directory rows for a team from Supabase (delta or full),
 * upsert into local cache, bump watermark.
 *
 * @returns number of rows synced
 */
export async function syncActorsForTeam(
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const WATERMARK_KEY = "actor_directory";
  const watermark = opts?.full
    ? null
    : await cache.getWatermark(WATERMARK_KEY, teamId);

  let data: ActorDirectorySyncRow[];
  try {
    data = await getBackend().sync.listActorDirectoryForSync(teamId, watermark);
  } catch (error) {
    console.warn("[actor-sync] pull failed:", error instanceof Error ? error.message : error);
    return 0;
  }

  const rows = (data ?? []).map(mapRow);
  if (rows.length > 0) {
    await cache.upsertActorsBatch(rows);
    const maxUpdated = rows.reduce(
      (acc, r) => (r.updatedAt > acc ? r.updatedAt : acc),
      watermark ?? "",
    );
    if (maxUpdated) {
      await cache.setWatermark(WATERMARK_KEY, teamId, maxUpdated);
    }
  }

  // Full-sync reconciliation: soft-delete local rows that are no longer
  // returned by actor_directory (e.g. removed agents, visibility changed).
  // This prevents stale actors from appearing in the new-session picker.
  if (opts?.full) {
    const freshIds = new Set(rows.map((r) => r.id));
    const local = await cache.loadActorsForTeam(teamId, false);
    const now = new Date().toISOString();
    for (const localRow of local) {
      if (!freshIds.has(localRow.id)) {
        await cache.softDeleteActor(localRow.id, now);
      }
    }
  }

  // Tell the reactive directory store fresh data landed so the live UI
  // (second column + RECENTS) re-reconciles without waiting for a restart.
  if (rows.length > 0 || opts?.full) {
    notifyActorDirectorySynced(teamId);
  }

  return rows.length;
}
