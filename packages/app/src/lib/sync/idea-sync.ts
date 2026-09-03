/**
 * idea-sync.ts — Sync ideas from Supabase into local libsql cache.
 *
 * updated_at: ✓ present on ideas (confirmed via information_schema)
 * Watermark key: "ideas" namespaced by teamId.
 */

import { syncTableForTeam } from "@/lib/cache/cache-sync";
import { getBackend } from "@/lib/backend";
import * as cache from "@/lib/cache/local-cache";
import { isTauri } from "@/lib/utils";
import type { IdeaSyncRow } from "@/lib/backend/types";

function mapRow(r: IdeaSyncRow): cache.IdeaRow {
  return {
    id: r.id,
    teamId: r.team_id,
    workspaceId: r.workspace_id ?? null,
    parentId: r.parent_idea_id ?? null,
    title: r.title,
    description: r.description ?? null,
    status: r.status ?? null,
    createdBy: r.created_by_actor_id ?? null,
    // Supabase returns boolean; local cache stores 0/1
    archived: r.archived ? 1 : 0,
    sortOrder: r.sort_order ?? 0,
    metadataJson: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: null,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Pull ideas for a team from Supabase (delta or full),
 * upsert into local cache, bump watermark.
 *
 * @returns number of rows synced
 */
export async function syncIdeasForTeam(
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const { count } = await syncTableForTeam<IdeaSyncRow, cache.IdeaRow>({
    watermarkKey: "ideas",
    teamId,
    pullRows: (updatedAfter) => getBackend().sync.listIdeasForSync(teamId, updatedAfter),
    mapRow,
    upsertBatch: cache.upsertIdeasBatch,
    full: opts?.full,
  });
  return count;
}
