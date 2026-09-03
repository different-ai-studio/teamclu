import { getBackend } from "@/lib/backend";
import { loadSessionsForTeam } from "@/lib/cache/local-cache";

/** In-memory created_by_actor_id per session — survives Actors panel unmount. */
const memory = new Map<string, string>();

export function getSessionCreatedByActorId(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  return memory.get(sessionId) ?? null;
}

export function rememberSessionCreatedByActorId(
  sessionId: string,
  actorId: string | null | undefined,
): void {
  if (!sessionId || !actorId) return;
  memory.set(sessionId, actorId);
}

export function seedSessionCreatedByFromRows(
  rows: Array<{ id: string; createdBy?: string | null; created_by_actor_id?: string | null }>,
): void {
  for (const row of rows) {
    rememberSessionCreatedByActorId(
      row.id,
      row.createdBy ?? row.created_by_actor_id ?? null,
    );
  }
}

export async function resolveSessionCreatedByActorId(
  sessionId: string,
  teamId: string | null,
): Promise<string | null> {
  const remembered = getSessionCreatedByActorId(sessionId);
  if (remembered) return remembered;

  if (teamId) {
    const cached = await loadSessionsForTeam(teamId);
    const hit = cached.find((s) => s.id === sessionId);
    if (hit?.createdBy) {
      rememberSessionCreatedByActorId(sessionId, hit.createdBy);
      return hit.createdBy;
    }
  }

  const detail = await getBackend().sessions.getSession(sessionId, teamId);
  const actorId = detail?.created_by_actor_id ?? null;
  rememberSessionCreatedByActorId(sessionId, actorId);
  return actorId;
}

/** Warm creator id when a session becomes active — panel open should be instant. */
export function preloadSessionCreatedByActorId(
  sessionId: string,
  teamId: string | null,
): void {
  if (getSessionCreatedByActorId(sessionId)) return;
  void resolveSessionCreatedByActorId(sessionId, teamId).catch(() => {});
}

/** @internal test-only */
export function clearSessionCreatedByCacheForTests(): void {
  memory.clear();
}
