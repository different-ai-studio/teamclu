import { clearTeamCache, loadSessions, saveSessions } from "../../lib/db/local-cache";
import { openCacheDb, type CacheDb } from "../../lib/db/cache-db";
import type { SessionSummary } from "./session-types";

export type SessionsCache = {
  load: (teamId: string) => Promise<SessionSummary[] | null>;
  save: (teamId: string, sessions: SessionSummary[]) => Promise<void>;
  clear: (teamId: string) => Promise<void>;
};

/**
 * Sessions-list cache. iOS reads its list instantly from SwiftData on cold
 * start; this gives Expo the same first paint while the network fetch is in
 * flight.
 *
 * Backed by SQLite rather than the single AsyncStorage blob it used to be. The
 * blob was rewritten in full on every change and clamped to 200 sessions, so a
 * team past that could not see its older sessions offline at all. Rows have no
 * such ceiling and a team switch reads its own scope instead of evicting the
 * other team's.
 */
export function createSessionsCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): SessionsCache {
  return {
    async load(teamId) {
      if (!teamId) return null;
      try {
        const rows = await loadSessions(await getCacheDb(), teamId);
        // Null, not [], distinguishes "nothing cached yet" from "cached empty" —
        // the list screen shows a spinner for the first and an empty state for
        // the second.
        if (rows.length === 0) return null;
        return rows.map((row) => ({
          sessionId: row.sessionId,
          teamId: row.teamId,
          title: row.title,
          summary: row.summary,
          participantCount: row.participantCount,
          participantActorIds: row.participantActorIds,
          lastMessagePreview: row.lastMessagePreview,
          lastMessageAt: row.lastMessageAt,
          createdAt: row.createdAt,
          createdBy: row.createdBy,
          hasUnread: row.hasUnread,
        }));
      } catch {
        return null;
      }
    },
    async save(teamId, sessions) {
      if (!teamId) return;
      try {
        await saveSessions(
          await getCacheDb(),
          teamId,
          sessions.map((session) => ({
            sessionId: session.sessionId,
            teamId: session.teamId || teamId,
            title: session.title,
            summary: session.summary,
            participantCount: session.participantCount,
            participantActorIds: session.participantActorIds ?? [],
            lastMessagePreview: session.lastMessagePreview,
            lastMessageAt: session.lastMessageAt,
            createdAt: session.createdAt,
            createdBy: session.createdBy,
            hasUnread: session.hasUnread ?? false,
          })),
        );
      } catch {
        // best-effort — cache is a hint, never a source of truth
      }
    },
    async clear(teamId) {
      if (!teamId) return;
      try {
        await clearTeamCache(await getCacheDb(), teamId);
      } catch {
        // ignore
      }
    },
  };
}

/**
 * The team's sessions for a screen that only reads them (search, the forward
 * picker, an actor's recent sessions): the rows the sessions list last cached,
 * or one network walk when nothing is cached yet.
 *
 * Each of those screens used to page through every session on the team on
 * every mount. The list refreshes the cache whenever it regains focus, so the
 * cached rows are at most one list visit old.
 */
export async function loadTeamSessionsPreferCache(
  teamId: string,
  listSessions: (teamId: string) => Promise<SessionSummary[]>,
  cache: Pick<SessionsCache, "load"> = createSessionsCache(),
): Promise<SessionSummary[]> {
  const cached = await cache.load(teamId);
  if (cached) return cached;
  return listSessions(teamId);
}
