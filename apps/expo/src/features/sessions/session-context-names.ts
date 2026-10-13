import type { SessionSummary } from "./session-types";

/**
 * The session list's third line (iOS #1597): the app a session was created
 * from, otherwise its idea. Names come from `GET /v1/apps` and
 * `GET /v1/ideas`, fetched only when some session needs one the cache can't
 * answer, and kept per team for the life of the app process so a refresh
 * doesn't blank them.
 */

export type SessionContext = { kind: "app" | "idea"; name: string };

/** Long enough for a name, short enough to leave the avatar cluster its room. */
export const CONTEXT_MAX_LENGTH = 16;

export function clipContextName(name: string): string {
  const chars = Array.from(name);
  return chars.length > CONTEXT_MAX_LENGTH
    ? `${chars.slice(0, CONTEXT_MAX_LENGTH).join("")}…`
    : name;
}

/** App wins over idea, as on iOS. Nothing named → no context. */
export function sessionContext(
  session: Pick<SessionSummary, "appId" | "ideaId">,
  appNames: ReadonlyMap<string, string>,
  ideaTitles: ReadonlyMap<string, string>,
): SessionContext | null {
  const appName = session.appId ? appNames.get(session.appId)?.trim() : "";
  if (appName) return { kind: "app", name: clipContextName(appName) };
  const ideaTitle = session.ideaId ? ideaTitles.get(session.ideaId)?.trim() : "";
  if (ideaTitle) return { kind: "idea", name: clipContextName(ideaTitle) };
  return null;
}

/** Whether any session belongs to an app — only then is `GET /v1/apps` worth it. */
export function hasAppSessions(sessions: readonly Pick<SessionSummary, "appId">[]): boolean {
  return sessions.some((session) => Boolean(session.appId));
}

/** Idea ids some session points at with no title known yet. */
export function ideaIdsMissingTitle(
  sessions: readonly Pick<SessionSummary, "ideaId">[],
  ideaTitles: ReadonlyMap<string, string>,
): Set<string> {
  const missing = new Set<string>();
  for (const session of sessions) {
    if (session.ideaId && !ideaTitles.get(session.ideaId)) missing.add(session.ideaId);
  }
  return missing;
}

/**
 * Merge freshly fetched names into the known ones. Upsert only: an id absent
 * from `fetched` (an app the caller can no longer see) keeps its last known
 * name rather than going blank; empty names are ignored. Returns the same map
 * when nothing changed, so callers can skip a re-render.
 */
export function mergeNames(
  known: ReadonlyMap<string, string>,
  fetched: Iterable<readonly [string, string]>,
): ReadonlyMap<string, string> {
  let next: Map<string, string> | null = null;
  for (const [id, rawName] of fetched) {
    const name = rawName.trim();
    if (!id || !name || known.get(id) === name) continue;
    next ??= new Map(known);
    next.set(id, name);
  }
  return next ?? known;
}
