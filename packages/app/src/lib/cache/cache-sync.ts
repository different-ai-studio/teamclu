/**
 * cache-sync.ts — Generic helpers for pulling Supabase rows into the local
 * libsql cache with watermark-based delta fetching.
 *
 * Schema notes (verified 2026-05-13):
 *   actors               — has updated_at ✓  (no deleted_at on Supabase; use soft-delete local only)
 *   sessions             — has updated_at ✓
 *   session_participants — has updated_at ✓  (no team_id column; scoped by session_id)
 *   messages             — has updated_at ✓
 *   ideas                — has updated_at ✓
 *   claims               — NOT in information_schema results → FULL-PULL ONLY (TODO: confirm schema)
 *   submissions          — NOT in information_schema results → FULL-PULL ONLY (TODO: confirm schema)
 *   team_workspace_config     — has updated_at ✓
 *   actor_message_feedback    — created_at only; FULL-PULL per team
 *   actor_session_report      — created_at only; FULL-PULL per team
 */

import * as cache from "@/lib/cache/local-cache";

// ── Team-scoped sync ────────────────────────────────────────────────────────

/**
 * Pull domain rows since the local watermark (delta sync),
 * upsert them into the local cache, and bump the watermark.
 *
 * The watermark key is namespaced by `teamId`.
 */
export async function syncTableForTeam<TSupabaseRow, TCacheRow>(args: {
  watermarkKey: string;
  teamId: string;
  pullRows: (updatedAfter: string | null) => Promise<TSupabaseRow[]>;
  mapRow: (r: TSupabaseRow) => TCacheRow;
  upsertBatch: (rows: TCacheRow[]) => Promise<void>;
  /** When true, ignore the watermark and pull all rows (forced full refresh). */
  full?: boolean;
}): Promise<{ count: number }> {
  const watermark = args.full
    ? null
    : await cache.getWatermark(args.watermarkKey, args.teamId);

  let data: TSupabaseRow[];
  try {
    data = await args.pullRows(watermark);
  } catch (error) {
    console.warn(`[cache-sync] ${args.watermarkKey} pull failed:`, error instanceof Error ? error.message : error);
    return { count: 0 };
  }

  const rows = (data ?? []).map(args.mapRow);
  if (rows.length > 0) {
    await args.upsertBatch(rows);
    // Bump watermark to the newest updated_at in this batch.
    const maxUpdated = rows.reduce<string>((acc, r) => {
      const u = (r as { updatedAt?: string }).updatedAt ?? "";
      return u > acc ? u : acc;
    }, watermark ?? "");
    if (maxUpdated) {
      await cache.setWatermark(args.watermarkKey, args.teamId, maxUpdated);
    }
  }
  return { count: rows.length };
}

// ── Session-scoped sync ─────────────────────────────────────────────────────

/**
 * Pull domain rows scoped to a single session. Watermark key is
 * `<watermarkKey>:<sessionId>`,
 * namespaced by `teamId`.
 */
export async function syncTableForSession<TSupabaseRow, TCacheRow>(args: {
  watermarkKey: string;
  sessionId: string;
  /** Used only for watermark namespacing. */
  teamId: string;
  pullRows: (updatedAfter: string | null) => Promise<TSupabaseRow[]>;
  mapRow: (r: TSupabaseRow) => TCacheRow;
  upsertBatch: (rows: TCacheRow[]) => Promise<void>;
  full?: boolean;
  /**
   * Full sync only: hand over every row the server still has, so the caller can
   * drop local rows it no longer does. A delta sync keyed on `updated_at` can
   * never observe a hard DELETE, so without this a removed row lives forever in
   * the cache.
   *
   * Deliberately not called when the pull failed (the early return above) — a
   * network error must never be read as "the server has nothing".
   */
  reconcileFull?: (rows: TCacheRow[]) => Promise<void>;
}): Promise<{ count: number }> {
  const wmKey = `${args.watermarkKey}:${args.sessionId}`;
  const watermark = args.full
    ? null
    : await cache.getWatermark(wmKey, args.teamId);

  let data: TSupabaseRow[];
  try {
    data = await args.pullRows(watermark);
  } catch (error) {
    console.warn(
      `[cache-sync] ${args.watermarkKey}@${args.sessionId} pull failed:`,
      error instanceof Error ? error.message : error,
    );
    return { count: 0 };
  }

  const rows = (data ?? []).map(args.mapRow);
  if (rows.length > 0) {
    await args.upsertBatch(rows);
    const maxUpdated = rows.reduce<string>((acc, r) => {
      const u = (r as { updatedAt?: string }).updatedAt ?? "";
      return u > acc ? u : acc;
    }, watermark ?? "");
    if (maxUpdated) {
      await cache.setWatermark(wmKey, args.teamId, maxUpdated);
    }
  }
  // Outside the `rows.length > 0` guard on purpose: a session whose every row
  // was removed returns nothing, and that is exactly when reconciling matters.
  if (args.full && args.reconcileFull) {
    await args.reconcileFull(rows);
  }
  return { count: rows.length };
}
