import type { MessageRow } from "@/lib/cache/local-cache";

/** chrome.storage.local key prefix for per-session message blobs. */
const SESSION_KEY_PREFIX = "teamclu.ext.msg.s.";

/** Index + eviction metadata for the extension message cache. */
export const META_KEY = "teamclu.ext.msg.meta";

/** Max sessions retained (LRU). */
export const MAX_SESSIONS = 20;

/** Soft byte budget for message blobs (leave headroom for other storage keys). */
export const MAX_BYTES = 6 * 1024 * 1024;

type SessionMeta = {
  lastAccessAt: number;
  bytes: number;
};

export type ExtensionMessageCacheMeta = {
  version: 1;
  /** sessionId → access / size */
  sessions: Record<string, SessionMeta>;
  /** messageId → sessionId for O(1) parts updates */
  idIndex: Record<string, string>;
};

export function sessionStorageKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export function emptyMeta(): ExtensionMessageCacheMeta {
  return { version: 1, sessions: {}, idIndex: {} };
}

export function estimateBytes(rows: MessageRow[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(rows)).length;
  } catch {
    return JSON.stringify(rows).length;
  }
}

export function isMessageRow(value: unknown): value is MessageRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.sessionId === "string" &&
    typeof row.kind === "string" &&
    typeof row.content === "string"
  );
}
