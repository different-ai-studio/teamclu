import { create } from "zustand";
import {
  deleteOutbox,
  listAllOutbox,
  upsertOutbox,
  type OutboxRow,
} from "@/lib/cache/local-cache";
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from "@/lib/session/session-flow-log";

export type OutboxState = "pending" | "inFlight" | "delivered" | "failed";

export interface OutboxEntry {
  messageId: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  model?: string | null;
  mentionActorIds: string[];
  displayMentionActorIds?: string[];
  attachmentUrls: string[];
  /** Cloud workspace UUID captured at enqueue — survives outbox retries. */
  workspaceIdHint?: string | null;
  state: OutboxState;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutboxStore {
  /** Keyed by messageId. */
  byId: Record<string, OutboxEntry>;
  /** UI-only: Cloud API insert succeeded; not persisted to libsql. */
  cloudPersistedIds: Record<string, true>;
  /** Hydrated from libsql on app boot. Idempotent. */
  hydrate: () => Promise<void>;
  /** Mark that insertOutgoingMessage succeeded (show delivered check early). */
  markCloudPersisted: (messageId: string) => void;
  /** Insert a brand-new outbox row in `pending` state. Writes through to
   * libsql so a crash before the first send doesn't lose the message. */
  enqueue: (
    input: Omit<
      OutboxEntry,
      | "state"
      | "attemptCount"
      | "lastAttemptAt"
      | "nextAttemptAt"
      | "lastError"
      | "createdAt"
      | "updatedAt"
    >,
  ) => Promise<void>;
  /** Update an existing entry's state machine fields. Write-through. */
  updateState: (
    messageId: string,
    patch: Partial<
      Pick<
        OutboxEntry,
        "state" | "attemptCount" | "lastAttemptAt" | "nextAttemptAt" | "lastError"
      >
    >,
  ) => Promise<void>;
  /** Remove an entry entirely (after `delivered` is observed by UI, or when
   * a `failed` row is manually cleared). */
  remove: (messageId: string) => Promise<void>;
  /** Reset a `failed` row back to `pending` for user-tap retry. */
  retry: (messageId: string) => Promise<void>;
}

const rowToEntry = (r: OutboxRow): OutboxEntry => ({
  messageId: r.messageId,
  teamId: r.teamId,
  sessionId: r.sessionId,
  senderActorId: r.senderActorId,
  content: r.content,
  model: r.model ?? null,
  mentionActorIds: r.mentionActorIdsJson
    ? (JSON.parse(r.mentionActorIdsJson) as string[])
    : [],
  displayMentionActorIds: r.displayMentionActorIdsJson
    ? (JSON.parse(r.displayMentionActorIdsJson) as string[])
    : [],
  attachmentUrls: r.attachmentUrlsJson
    ? (JSON.parse(r.attachmentUrlsJson) as string[])
    : [],
  state: r.state as OutboxState,
  attemptCount: r.attemptCount,
  lastAttemptAt: r.lastAttemptAt ?? null,
  nextAttemptAt: r.nextAttemptAt ?? null,
  lastError: r.lastError ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const entryToRow = (e: OutboxEntry): OutboxRow => ({
  messageId: e.messageId,
  teamId: e.teamId,
  sessionId: e.sessionId,
  senderActorId: e.senderActorId,
  content: e.content,
  model: e.model ?? null,
  mentionActorIdsJson:
    e.mentionActorIds.length > 0 ? JSON.stringify(e.mentionActorIds) : null,
  displayMentionActorIdsJson:
    e.displayMentionActorIds && e.displayMentionActorIds.length > 0
      ? JSON.stringify(e.displayMentionActorIds)
      : null,
  attachmentUrlsJson:
    e.attachmentUrls.length > 0 ? JSON.stringify(e.attachmentUrls) : null,
  state: e.state,
  attemptCount: e.attemptCount,
  lastAttemptAt: e.lastAttemptAt,
  nextAttemptAt: e.nextAttemptAt,
  lastError: e.lastError,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

let hydrated = false;

export const useOutboxStore = create<OutboxStore>((set, get) => ({
  byId: {},
  cloudPersistedIds: {},

  markCloudPersisted: (messageId) => {
    set((s) => {
      if (s.cloudPersistedIds[messageId]) return s;
      return {
        cloudPersistedIds: { ...s.cloudPersistedIds, [messageId]: true },
      };
    });
  },

  hydrate: async () => {
    if (hydrated) return;
    hydrated = true;
    try {
      sessionFlowLog("outbox.hydrate.begin");
      const rows = await listAllOutbox();
      const byId: Record<string, OutboxEntry> = {};
      for (const r of rows) byId[r.messageId] = rowToEntry(r);
      set({ byId });
      sessionFlowLog("outbox.hydrate.ok", {
        rowCount: rows.length,
        pendingCount: rows.filter((r) => r.state === "pending").length,
        failedCount: rows.filter((r) => r.state === "failed").length,
      });
    } catch (e) {
      sessionFlowError("outbox.hydrate.failed", e);
      console.warn("[outbox] hydrate failed", e);
    }
  },

  enqueue: async (input) => {
    const now = new Date().toISOString();
    sessionFlowLog("outbox.enqueue.begin", {
      messageId: input.messageId,
      sessionId: input.sessionId,
      teamId: input.teamId,
      senderActorId: input.senderActorId,
      model: input.model ?? null,
      mentionActorCount: input.mentionActorIds.length,
      displayMentionActorCount: input.displayMentionActorIds?.length ?? 0,
      attachmentUrlCount: input.attachmentUrls.length,
      ...summarizeText(input.content),
    });
    const entry: OutboxEntry = {
      ...input,
      state: "pending",
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ byId: { ...s.byId, [entry.messageId]: entry } }));
    try {
      await upsertOutbox(entryToRow(entry));
      sessionFlowLog("outbox.enqueue.ok", {
        messageId: entry.messageId,
        sessionId: entry.sessionId,
        teamId: entry.teamId,
        state: entry.state,
        nextAttemptAt: entry.nextAttemptAt,
      });
    } catch (e) {
      sessionFlowError("outbox.enqueue.persist_failed", e, {
        messageId: entry.messageId,
        sessionId: entry.sessionId,
        teamId: entry.teamId,
      });
      console.warn("[outbox] enqueue persist failed", e);
    }
    // Do not wait for the 1s polling interval — the bubble already has a
    // spinner and the user is waiting on Cloud insert + MQTT. Kicking only
    // after the row is persisted keeps libsql and memory state in agreement.
    void import("@/services/outbox-sender").then(({ kickOutboxSender }) => {
      kickOutboxSender();
    });
  },

  updateState: async (messageId, patch) => {
    const prev = get().byId[messageId];
    if (!prev) return;
    const now = new Date().toISOString();
    const next: OutboxEntry = { ...prev, ...patch, updatedAt: now };
    sessionFlowLog("outbox.state_update", {
      messageId,
      sessionId: prev.sessionId,
      teamId: prev.teamId,
      fromState: prev.state,
      toState: next.state,
      attemptCount: next.attemptCount,
      nextAttemptAt: next.nextAttemptAt,
      hasLastError: !!next.lastError,
    });
    set((s) => ({ byId: { ...s.byId, [messageId]: next } }));
    try {
      await upsertOutbox(entryToRow(next));
    } catch (e) {
      sessionFlowError("outbox.state_update.persist_failed", e, {
        messageId,
        sessionId: prev.sessionId,
        teamId: prev.teamId,
        toState: next.state,
      });
      console.warn("[outbox] updateState persist failed", e);
    }
  },

  remove: async (messageId) => {
    const prev = get().byId[messageId];
    sessionFlowLog("outbox.remove.begin", {
      messageId,
      sessionId: prev?.sessionId,
      teamId: prev?.teamId,
      state: prev?.state,
    });
    set((s) => {
      const next = { ...s.byId };
      delete next[messageId];
      const cloudPersistedIds = { ...s.cloudPersistedIds };
      delete cloudPersistedIds[messageId];
      return { byId: next, cloudPersistedIds };
    });
    try {
      await deleteOutbox(messageId);
      sessionFlowLog("outbox.remove.ok", { messageId });
    } catch (e) {
      sessionFlowError("outbox.remove.persist_failed", e, {
        messageId,
        sessionId: prev?.sessionId,
        teamId: prev?.teamId,
      });
      console.warn("[outbox] remove persist failed", e);
    }
  },

  retry: async (messageId) => {
    const prev = get().byId[messageId];
    if (!prev) return;
    const now = new Date().toISOString();
    sessionFlowLog("outbox.retry", {
      messageId,
      sessionId: prev.sessionId,
      teamId: prev.teamId,
      previousAttemptCount: prev.attemptCount,
      previousError: prev.lastError,
    });
    const next: OutboxEntry = {
      ...prev,
      state: "pending",
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: now,
      lastError: null,
      updatedAt: now,
    };
    set((s) => {
      const cloudPersistedIds = { ...s.cloudPersistedIds };
      delete cloudPersistedIds[messageId];
      return { byId: { ...s.byId, [messageId]: next }, cloudPersistedIds };
    });
    try {
      await upsertOutbox(entryToRow(next));
    } catch (e) {
      sessionFlowError("outbox.retry.persist_failed", e, {
        messageId,
        sessionId: prev.sessionId,
        teamId: prev.teamId,
      });
      console.warn("[outbox] retry persist failed", e);
    }
  },
}));

/** Exponential backoff matching iOS `OutboxSender`:
 *   delay = min(0.5 * 2^min(attempt-1, 6), 30) seconds
 * Attempt 1 → 0.5s · 2 → 1s · 3 → 2s · 7+ → 30s (capped). */
export function outboxBackoffMs(attempt: number): number {
  const a = Math.max(1, attempt);
  const exp = Math.min(a - 1, 6);
  const seconds = Math.min(0.5 * Math.pow(2, exp), 30);
  return Math.round(seconds * 1000);
}

export const OUTBOX_MAX_ATTEMPTS = 20;
