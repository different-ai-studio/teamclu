/**
 * Exclusive session-list bucket — mirrors `amux.sessions.list_kind`.
 *
 * Order matches the generated column: cron → gateway → app → thread → user.
 * The sidebar dropdown pages by these four (thread stays out of the list).
 */
export type SessionListKind = "user" | "gateway" | "app" | "cron";

export type SessionListKindParam = SessionListKind | "all" | "regular";

const LIST_KINDS: ReadonlySet<string> = new Set(["user", "gateway", "app", "cron"]);

export function isSessionListKind(value: string): value is SessionListKind {
  return LIST_KINDS.has(value);
}

/** Derive the bucket when the server has not yet sent `listKind`. */
export function deriveSessionListKind(row: {
  source?: string | null;
  app_id?: string | null;
  appId?: string | null;
  list_kind?: string | null;
  listKind?: string | null;
}): SessionListKind | "thread" {
  const stored = row.list_kind ?? row.listKind;
  if (stored === "user" || stored === "gateway" || stored === "app" || stored === "cron" || stored === "thread") {
    return stored;
  }
  const source = row.source ?? "user";
  if (source === "cron") return "cron";
  if (source === "gateway") return "gateway";
  if (row.app_id || row.appId) return "app";
  if (source === "thread") return "thread";
  return "user";
}

export function sessionMatchesListKind(
  row: {
    id: string;
    source?: string | null;
    app_id?: string | null;
    appId?: string | null;
    list_kind?: string | null;
    listKind?: string | null;
  },
  kind: SessionListKind,
  cronSessionIds?: ReadonlySet<string>,
): boolean {
  if (kind === "cron" && cronSessionIds?.has(row.id)) return true;
  return deriveSessionListKind(row) === kind;
}
