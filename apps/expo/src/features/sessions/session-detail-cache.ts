import {
  type CachedMessage,
  deleteMessages,
  loadMessages,
  loadSessions,
  saveMessages,
  saveSessions,
  upsertMessages,
} from "../../lib/db/local-cache";
import { openCacheDb, type CacheDb } from "../../lib/db/cache-db";
import type { MessageAttachment, SessionMessage, SessionSummary } from "./session-types";

export type SessionDetailCacheEntry = {
  session: SessionSummary;
  messages: SessionMessage[];
};

export type SessionDetailCache = {
  load: (sessionId: string) => Promise<SessionDetailCacheEntry | null>;
  save: (sessionId: string, entry: SessionDetailCacheEntry) => Promise<void>;
  saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<void>;
  clear: (sessionId: string) => Promise<void>;
};

/**
 * Per-session metadata + timeline cache, mirroring iOS's SwiftData hydration:
 * paint from disk immediately, let the network refresh overlay on top.
 *
 * Backed by SQLite rather than two AsyncStorage blobs. The blobs were clamped
 * to the newest 200 messages and rewritten whole on every append — including on
 * every streaming flush, which is why the streaming write is coalesced upstream
 * in `session-detail-controller`. Rows carry no such clamp, so scrolling back
 * through a long session no longer has to hit the network.
 */
/** How many of a session's newest rows its first frame reads. */
const FIRST_PAINT_MESSAGES = 120;
const PREFETCH_TTL_MS = 5_000;
const prefetchedMessages = new Map<string, { at: number; rows: Promise<CachedMessage[]> }>();

/**
 * Starts reading a session's newest rows the moment the list is tapped, so the
 * read overlaps the screen transition instead of starting after the detail
 * screen mounts. The detail cache's next `load` of that session takes it.
 */
export function prefetchSessionMessages(
  sessionId: string,
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): void {
  if (!sessionId) return;
  prefetchedMessages.set(sessionId, {
    at: Date.now(),
    rows: getCacheDb()
      .then((db) => loadMessages(db, sessionId, FIRST_PAINT_MESSAGES))
      .catch(() => []),
  });
}

function takePrefetchedMessages(sessionId: string): Promise<CachedMessage[]> | null {
  const entry = prefetchedMessages.get(sessionId);
  prefetchedMessages.delete(sessionId);
  return entry && Date.now() - entry.at < PREFETCH_TTL_MS ? entry.rows : null;
}

export function createSessionDetailCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): SessionDetailCache {
  /** What each session's last write held, by message id. */
  const lastSaved = new Map<string, Map<string, SessionMessage>>();
  const toSessionMessage = (row: {
    messageId: string;
    sessionId: string;
    teamId: string;
    senderActorId: string;
    kind: string;
    content: string;
    model: string;
    turnId: string;
    replyToMessageId: string;
    metadata: unknown;
    attachments: unknown[];
    createdAt: string;
  }): SessionMessage => ({
    messageId: row.messageId,
    sessionId: row.sessionId,
    teamId: row.teamId,
    senderActorId: row.senderActorId,
    kind: row.kind,
    content: row.content,
    model: row.model,
    turnId: row.turnId,
    replyToMessageId: row.replyToMessageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    attachments: row.attachments as MessageAttachment[],
  });

  return {
    async load(sessionId) {
      if (!sessionId) return null;
      try {
        const db = await getCacheDb();
        // The newest rows only: enough to fill the screen and the network's
        // first page, without reading a long session's whole history before
        // the first frame. Older pages come from the network as you scroll.
        const prefetched = takePrefetchedMessages(sessionId);
        const messages = prefetched
          ? await prefetched
          : await loadMessages(db, sessionId, FIRST_PAINT_MESSAGES);
        // The session row is scoped by team, and the caller only knows the
        // session id, so find it by walking the message rows' team back into
        // the sessions table. A session with no cached messages still has a
        // cached header if the list screen wrote one.
        const teamId = messages[0]?.teamId ?? "";
        const session = teamId
          ? (await loadSessions(db, teamId)).find(
              (row) => row.sessionId === sessionId,
            )
          : undefined;
        if (!session) return null;
        const loaded = messages.map(toSessionMessage);
        // What disk holds, as far as this load saw: the next write diffs
        // against it, so it never rewrites or trims the rows it did not read.
        lastSaved.set(sessionId, new Map(loaded.map((message) => [message.messageId, message])));
        return {
          session: {
            sessionId: session.sessionId,
            teamId: session.teamId,
            title: session.title,
            summary: session.summary,
            participantCount: session.participantCount,
            participantActorIds: session.participantActorIds,
            lastMessagePreview: session.lastMessagePreview,
            lastMessageAt: session.lastMessageAt,
            createdAt: session.createdAt,
            createdBy: session.createdBy,
            hasUnread: session.hasUnread,
          },
          messages: loaded,
        };
      } catch {
        return null;
      }
    },
    async save(sessionId, entry) {
      if (!sessionId) return;
      try {
        const db = await getCacheDb();
        const teamId = entry.session.teamId;
        if (teamId) {
          // Merge rather than replace: the sessions scope belongs to the list
          // screen, and blowing it away here would empty the list cache every
          // time a detail screen opened.
          const existing = await loadSessions(db, teamId);
          const merged = [
            ...existing.filter((row) => row.sessionId !== sessionId),
            {
              sessionId: entry.session.sessionId,
              teamId,
              title: entry.session.title,
              summary: entry.session.summary,
              participantCount: entry.session.participantCount,
              participantActorIds: entry.session.participantActorIds ?? [],
              lastMessagePreview: entry.session.lastMessagePreview,
              lastMessageAt: entry.session.lastMessageAt,
              createdAt: entry.session.createdAt,
              createdBy: entry.session.createdBy,
              hasUnread: entry.session.hasUnread ?? false,
            },
          ];
          await saveSessions(db, teamId, merged);
        }
        await this.saveMessages(sessionId, entry.messages);
      } catch {
        // best-effort
      }
    },
    async saveMessages(sessionId, messages) {
      if (!sessionId) return;
      // Timeline rows are immutable: a message that changed is a new object.
      // When nothing was removed since the last write, only the rows whose
      // object changed need writing — during a busy turn that is a handful,
      // against rewriting the whole session every second.
      // After a load, rows older than what it read stay on disk: only rows
      // that were known and are now gone get deleted.
      const previous = lastSaved.get(sessionId);
      const nextIds = new Set(messages.map((message) => message.messageId));
      const removed = previous ? [...previous.keys()].filter((id) => !nextIds.has(id)) : [];
      const toWrite = previous
        ? messages.filter((message) => previous.get(message.messageId) !== message)
        : messages;
      try {
        const db = await getCacheDb();
        if (previous) await deleteMessages(db, sessionId, removed);
        await (previous ? upsertMessages : saveMessages)(
          db,
          sessionId,
          toWrite.map((message) => ({
            messageId: message.messageId,
            sessionId: message.sessionId || sessionId,
            teamId: message.teamId,
            senderActorId: message.senderActorId,
            kind: message.kind,
            content: message.content,
            model: message.model,
            turnId: message.turnId,
            replyToMessageId: message.replyToMessageId,
            metadata: message.metadata,
            attachments: message.attachments ?? [],
            createdAt: message.createdAt,
          })),
        );
        // Only after the write landed, so rows a failed write missed go next time.
        lastSaved.set(sessionId, new Map(messages.map((message) => [message.messageId, message])));
      } catch {
        // best-effort
      }
    },
    async clear(sessionId) {
      if (!sessionId) return;
      lastSaved.delete(sessionId);
      try {
        await saveMessages(await getCacheDb(), sessionId, []);
      } catch {
        // ignore
      }
    },
  };
}
