import type { MessageRow } from "@/lib/cache/local-cache";
import { readChromeStorageLocal } from "./chrome-storage";
import { applyEvictionToMeta, pickSessionsToEvict } from "./evict";
import {
  emptyMeta,
  estimateBytes,
  isMessageRow,
  META_KEY,
  sessionStorageKey,
  type ExtensionMessageCacheMeta,
} from "./types";

function coalescePartsJson(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const next = incoming?.trim() ? incoming : null;
  if (next) return next;
  const prev = existing?.trim() ? existing : null;
  return prev;
}

function mergeMessageRow(existing: MessageRow | undefined, incoming: MessageRow): MessageRow {
  if (!existing) return { ...incoming };
  return {
    ...existing,
    ...incoming,
    partsJson: coalescePartsJson(incoming.partsJson, existing.partsJson),
  };
}

function parseSessionRows(raw: unknown): MessageRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMessageRow);
}

async function readMeta(): Promise<ExtensionMessageCacheMeta> {
  const storage = readChromeStorageLocal();
  if (!storage) return emptyMeta();
  try {
    const bag = await storage.get(META_KEY);
    const raw = bag[META_KEY];
    if (!raw || typeof raw !== "object") return emptyMeta();
    const obj = raw as Partial<ExtensionMessageCacheMeta>;
    return {
      version: 1,
      sessions:
        obj.sessions && typeof obj.sessions === "object" ? { ...obj.sessions } : {},
      idIndex:
        obj.idIndex && typeof obj.idIndex === "object" ? { ...obj.idIndex } : {},
    };
  } catch {
    return emptyMeta();
  }
}

async function writeMeta(meta: ExtensionMessageCacheMeta): Promise<void> {
  const storage = readChromeStorageLocal();
  if (!storage) return;
  await storage.set({ [META_KEY]: meta });
}

async function readSessionRows(sessionId: string): Promise<MessageRow[]> {
  const storage = readChromeStorageLocal();
  if (!storage) return [];
  try {
    const key = sessionStorageKey(sessionId);
    const bag = await storage.get(key);
    return parseSessionRows(bag[key]);
  } catch {
    return [];
  }
}

async function writeSessionRows(
  sessionId: string,
  rows: MessageRow[],
  meta: ExtensionMessageCacheMeta,
): Promise<ExtensionMessageCacheMeta> {
  const storage = readChromeStorageLocal();
  if (!storage) return meta;

  const bytes = estimateBytes(rows);
  const now = Date.now();
  const nextMeta: ExtensionMessageCacheMeta = {
    version: 1,
    sessions: {
      ...meta.sessions,
      [sessionId]: { lastAccessAt: now, bytes },
    },
    idIndex: { ...meta.idIndex },
  };
  for (const row of rows) {
    nextMeta.idIndex[row.id] = sessionId;
  }

  await storage.set({
    [sessionStorageKey(sessionId)]: rows,
    [META_KEY]: nextMeta,
  });
  return nextMeta;
}

/** Drop excess sessions by LRU count + byte budget. Optionally protect one session. */
export async function pruneExtensionMessageCache(opts?: {
  protectSessionId?: string | null;
}): Promise<string[]> {
  const storage = readChromeStorageLocal();
  if (!storage) return [];

  const meta = await readMeta();
  const victims = pickSessionsToEvict(meta, {
    protectSessionId: opts?.protectSessionId,
  });
  if (victims.length === 0) return [];

  const { meta: nextMeta, keysToRemove } = applyEvictionToMeta(meta, victims);
  await storage.remove(keysToRemove);
  await writeMeta(nextMeta);
  return victims;
}

export async function upsertExtensionMessagesBatch(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const storage = readChromeStorageLocal();
  if (!storage) return;

  const bySession = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  let meta = await readMeta();
  for (const [sessionId, incoming] of bySession) {
    const existing = await readSessionRows(sessionId);
    const byId = new Map(existing.map((r) => [r.id, r]));
    for (const row of incoming) {
      byId.set(row.id, mergeMessageRow(byId.get(row.id), row));
    }
    const merged = [...byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    meta = await writeSessionRows(sessionId, merged, meta);
  }

  await pruneExtensionMessageCache({
    protectSessionId: rows[0]?.sessionId ?? null,
  });
}

export async function loadExtensionMessagesForSession(
  sessionId: string,
  includeDeleted = false,
): Promise<MessageRow[]> {
  const rows = await readSessionRows(sessionId);
  const meta = await readMeta();
  if (meta.sessions[sessionId]) {
    const nextMeta: ExtensionMessageCacheMeta = {
      ...meta,
      sessions: {
        ...meta.sessions,
        [sessionId]: {
          ...meta.sessions[sessionId],
          lastAccessAt: Date.now(),
        },
      },
    };
    await writeMeta(nextMeta);
  }

  void pruneExtensionMessageCache({ protectSessionId: sessionId });

  if (includeDeleted) return rows;
  return rows.filter((r) => !r.deletedAt);
}

export async function setExtensionMessageParts(
  messageId: string,
  partsJson: string,
): Promise<string> {
  const storage = readChromeStorageLocal();
  if (!storage) return partsJson;

  const meta = await readMeta();
  let sessionId = meta.idIndex[messageId];
  let rows: MessageRow[] = [];

  if (sessionId) {
    rows = await readSessionRows(sessionId);
  } else {
    // Fallback scan if index is stale / missing
    for (const sid of Object.keys(meta.sessions)) {
      const candidate = await readSessionRows(sid);
      if (candidate.some((r) => r.id === messageId)) {
        sessionId = sid;
        rows = candidate;
        break;
      }
    }
  }

  if (!sessionId) {
    // Message row not cached yet — nothing to attach; caller still keeps partsJson in memory.
    return partsJson;
  }

  const nextRows = rows.map((r) =>
    r.id === messageId ? { ...r, partsJson } : r,
  );
  // If message missing from session blob, skip write
  if (!rows.some((r) => r.id === messageId)) return partsJson;

  await writeSessionRows(sessionId, nextRows, meta);
  await pruneExtensionMessageCache({ protectSessionId: sessionId });
  return partsJson;
}

export async function softDeleteExtensionMessage(
  id: string,
  deletedAt: string,
): Promise<void> {
  const meta = await readMeta();
  const sessionId = meta.idIndex[id];
  if (!sessionId) return;
  const rows = await readSessionRows(sessionId);
  const next = rows.map((r) => (r.id === id ? { ...r, deletedAt } : r));
  await writeSessionRows(sessionId, next, meta);
}
