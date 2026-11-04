/**
 * Session-list v2 kind partition. Must match
 * `amux.list_current_actor_sessions_v2` (20261102000000).
 */
export type SessionListKind = "regular" | "channel" | "app" | "cron";

export const SESSION_LIST_KINDS: readonly SessionListKind[] = [
  "regular",
  "channel",
  "app",
  "cron",
] as const;

/** TTL before a cached kind page is treated as stale on re-select. */
export const SESSION_LIST_KIND_TTL_MS = 30_000;

export function classifySessionListKind(row: {
  source?: string | null;
  app_id?: string | null;
}): SessionListKind | null {
  const source = row.source ?? "user";
  if (source === "cron") return "cron";
  if (source === "gateway") return "channel";
  if (row.app_id) return "app";
  if (source === "user") return "regular";
  return null;
}

export function isSessionListKind(
  row: { source?: string | null; app_id?: string | null },
  kind: SessionListKind,
): boolean {
  return classifySessionListKind(row) === kind;
}
