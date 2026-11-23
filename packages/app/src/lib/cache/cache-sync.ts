/**
 * cache-sync.ts — Generic helper for pulling Cloud API rows into the local
 * libsql cache with watermark-based delta fetching.
 *
 * The caller supplies `pullRows` (a Cloud API read that honours
 * `updatedAfter`), `mapRow` and `upsertBatch`; today that is `lib/sync/idea-sync.ts`.
 * Sessions, messages and actors have their own sync modules in `lib/sync/`.
 */

import * as cache from "@/lib/cache/local-cache";

// ── Team-scoped sync ────────────────────────────────────────────────────────

/**
 * Pull domain rows since the local watermark (delta sync),
 * upsert them into the local cache, and bump the watermark.
 *
 * The watermark key is namespaced by `teamId`.
 */
export async function syncTableForTeam<TRemoteRow, TCacheRow>(args: {
  watermarkKey: string;
  teamId: string;
  pullRows: (updatedAfter: string | null) => Promise<TRemoteRow[]>;
  mapRow: (r: TRemoteRow) => TCacheRow;
  upsertBatch: (rows: TCacheRow[]) => Promise<void>;
  /** When true, ignore the watermark and pull all rows (forced full refresh). */
  full?: boolean;
}): Promise<{ count: number }> {
  const watermark = args.full
    ? null
    : await cache.getWatermark(args.watermarkKey, args.teamId);

  let data: TRemoteRow[];
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
