import type { CacheDb } from "../../lib/db/local-cache";

/**
 * Row order for the New Session collaborator picker — iOS
 * `ActorPickerOrdering` (#1602): the viewer's default agent first, then
 * everyone else by most recent contact, then the never-contacted by name.
 */

/** Epoch ms of the most recent message each actor sent. */
export type LastContactByActor = ReadonlyMap<string, number>;

/** Newest timestamp per actor; unparseable timestamps are ignored. */
export function lastContactByActor(
  senders: ReadonlyArray<{ actorId: string; at: string | number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const sender of senders) {
    if (!sender.actorId) continue;
    const at = typeof sender.at === "number" ? sender.at : Date.parse(sender.at);
    if (!Number.isFinite(at)) continue;
    const current = out.get(sender.actorId);
    if (current === undefined || at > current) out.set(sender.actorId, at);
  }
  return out;
}

export function orderActorsForPicker<T extends { actorId: string; displayName: string }>(
  items: ReadonlyArray<T>,
  pinnedId: string | null | undefined,
  lastContact: LastContactByActor,
): T[] {
  return [...items].sort((a, b) => {
    if (pinnedId && a.actorId !== b.actorId) {
      if (a.actorId === pinnedId) return -1;
      if (b.actorId === pinnedId) return 1;
    }
    const x = lastContact.get(a.actorId);
    const y = lastContact.get(b.actorId);
    if (x !== undefined && y !== undefined && x !== y) return y - x;
    if (x !== undefined && y === undefined) return -1;
    if (x === undefined && y !== undefined) return 1;
    const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0;
  });
}

/**
 * Last-contact times from the local message cache. The cache only holds
 * sessions the viewer opened, so this reads as "last time we talked" — the
 * same source iOS uses (its SwiftData message store). Best-effort: a cache
 * that cannot be read orders by name.
 */
export async function loadLastContactByActor(
  db: CacheDb,
  teamId: string,
): Promise<Map<string, number>> {
  if (!teamId) return new Map();
  try {
    const rows = await db.getAllAsync(
      "SELECT sender_actor_id, MAX(created_at) AS last_at FROM cached_messages WHERE team_id = ? GROUP BY sender_actor_id",
      teamId,
    );
    return lastContactByActor(
      rows.map((row) => ({
        actorId: row.sender_actor_id == null ? "" : String(row.sender_actor_id),
        at: row.last_at == null ? "" : String(row.last_at),
      })),
    );
  } catch {
    return new Map();
  }
}
