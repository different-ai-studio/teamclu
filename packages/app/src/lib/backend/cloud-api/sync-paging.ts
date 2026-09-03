import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

/**
 * Walks a paginated `/v1/sync/*` endpoint to exhaustion.
 *
 * The sync endpoints are keyset-paginated on (updated_at, id) and report
 * `nextCursor`. A caller that reads only the first page silently drops every
 * change past it — which is exactly what `listSessionsForTeamSince` did: the
 * server had paginated that route (default 50) while this client took
 * `out.items` and returned, so a team with more than 50 changes since the last
 * watermark lost the remainder on every sync.
 *
 * Sync callers want "everything changed since X" as one list, so paging belongs
 * here rather than in each caller: the delta-sync code stays a single call and
 * cannot forget the cursor.
 */

/** Server-side maximum for `parseLimit`; a larger value is rejected as a 400. */
const SYNC_PAGE_SIZE = 100;

/**
 * Backstop against a server that keeps handing back a cursor. At the page size
 * above this is 100k rows — far past any real delta, so hitting it means
 * something is wrong, and it is logged rather than silently truncated.
 */
const MAX_PAGES = 1000;

export async function fetchAllSyncPages<T>(
  client: CloudApiClient,
  path: string,
  params: Record<string, string | null | undefined>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") search.set(key, value);
    }
    search.set("limit", String(SYNC_PAGE_SIZE));
    if (cursor) search.set("cursor", cursor);

    const out = await client.get<{ items?: T[]; nextCursor?: string | null }>(
      `${path}?${search.toString()}`,
    );
    all.push(...(out.items ?? []));
    cursor = out.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  if (cursor) {
    console.warn(
      `[sync] ${path} still had a cursor after ${MAX_PAGES} pages (${all.length} rows); ` +
        "stopping short — this delta is incomplete.",
    );
  }

  return all;
}
