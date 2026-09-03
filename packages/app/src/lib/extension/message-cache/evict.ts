import type { ExtensionMessageCacheMeta } from "./types";
import { MAX_BYTES, MAX_SESSIONS, sessionStorageKey } from "./types";

/**
 * Pick session ids to drop so remaining count ≤ maxSessions and bytes ≤ maxBytes.
 * Never evicts `protectSessionId`. Oldest `lastAccessAt` first.
 */
export function pickSessionsToEvict(
  meta: ExtensionMessageCacheMeta,
  opts?: {
    maxSessions?: number;
    maxBytes?: number;
    protectSessionId?: string | null;
  },
): string[] {
  const maxSessions = opts?.maxSessions ?? MAX_SESSIONS;
  const maxBytes = opts?.maxBytes ?? MAX_BYTES;
  const protect = opts?.protectSessionId?.trim() || null;

  const victims: string[] = [];
  let sessionCount = Object.keys(meta.sessions).length;
  let totalBytes = Object.values(meta.sessions).reduce((n, s) => n + s.bytes, 0);

  const sorted = Object.entries(meta.sessions)
    .filter(([id]) => id !== protect)
    .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);

  for (const [sessionId, info] of sorted) {
    if (sessionCount <= maxSessions && totalBytes <= maxBytes) break;
    victims.push(sessionId);
    sessionCount -= 1;
    totalBytes -= info.bytes;
  }

  return victims;
}

export function applyEvictionToMeta(
  meta: ExtensionMessageCacheMeta,
  sessionIds: string[],
): { meta: ExtensionMessageCacheMeta; keysToRemove: string[] } {
  if (sessionIds.length === 0) {
    return { meta, keysToRemove: [] };
  }
  const next: ExtensionMessageCacheMeta = {
    version: 1,
    sessions: { ...meta.sessions },
    idIndex: { ...meta.idIndex },
  };
  const evicted = new Set(sessionIds);
  for (const id of sessionIds) {
    delete next.sessions[id];
  }
  for (const [messageId, sessionId] of Object.entries(next.idIndex)) {
    if (evicted.has(sessionId)) delete next.idIndex[messageId];
  }
  return {
    meta: next,
    keysToRemove: sessionIds.map(sessionStorageKey),
  };
}
