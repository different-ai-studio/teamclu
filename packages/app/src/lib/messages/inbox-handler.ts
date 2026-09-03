// packages/app/src/lib/inbox-handler.ts
//
// Handles incoming MQTT pings on `inbox/<user_id>` (published by FC fan-out
// after each message INSERT or mark-viewed). The payload shape:
//   { type?: "message" | "read", session_id, ts }
// `type` is optional for backward compatibility — absent means "message".
// For message pings the client patches unread optimistically, then debounces
// a list reload to sync preview text and sort order.

import {
  scheduleMarkActiveSessionRead,
  shouldMarkSessionUnread,
} from "@/lib/session/active-session-read";
import { mqttSubscribe } from "@/lib/mqtt/mqtt-bridge";

interface InboxPing {
  session_id: string;
  type?: "message" | "read";
  ts?: number;
}

interface InboxEnvelope {
  topic: string;
  // Accepts the live bridge's Uint8Array as well as plain number[] (tests).
  // The handler always wraps via `new Uint8Array(env.bytes)`, which takes both.
  bytes: Uint8Array | number[];
}

/** Debounce window for coalescing burst list-refresh triggers into one fetch. */
export const SESSION_LIST_REFRESH_MS = 300;
/** @deprecated Use SESSION_LIST_REFRESH_MS */
export const INBOX_LIST_REFRESH_MS = SESSION_LIST_REFRESH_MS;

let sessionListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let subscribedInboxUserId: string | null = null;
let pendingInboxSubscribe: Promise<void> | null = null;
let inboxSubscribeEpoch = 0;

function inboxTopicForUser(userId: string): string {
  return `inbox/${userId.trim()}`;
}

/** Idempotent SUB to the per-user inbox topic (FC push fan-out). */
export async function ensureInboxSubscribed(userId: string): Promise<void> {
  const trimmed = userId.trim();
  if (!trimmed) return;
  while (true) {
    if (subscribedInboxUserId === trimmed) return;
    const pending = pendingInboxSubscribe;
    if (pending) {
      await pending;
      continue;
    }
    const epoch = inboxSubscribeEpoch;
    const topic = inboxTopicForUser(trimmed);
    const subscription = mqttSubscribe(topic);
    pendingInboxSubscribe = subscription;
    try {
      await subscription;
    } finally {
      if (pendingInboxSubscribe === subscription) {
        pendingInboxSubscribe = null;
      }
    }
    if (inboxSubscribeEpoch !== epoch) continue;
    subscribedInboxUserId = trimmed;
    return;
  }
}

/** Clears inbox SUB bookkeeping (e.g. after mqtt_connect wipes broker subscriptions). */
export function resetInboxSubscriptionState(): void {
  inboxSubscribeEpoch += 1;
  subscribedInboxUserId = null;
  pendingInboxSubscribe = null;
}

/** Test hook — clears pending debounced refresh. */
export function resetSessionListRefreshForTests(): void {
  if (sessionListRefreshTimer) {
    clearTimeout(sessionListRefreshTimer);
    sessionListRefreshTimer = null;
  }
  resetInboxSubscriptionState();
}

/** @deprecated Use resetSessionListRefreshForTests */
export const resetInboxListRefreshForTests = resetSessionListRefreshForTests;

/** Shared by inbox pings and session/live events (e.g. unknown session message.created). */
export function scheduleSessionListRefresh(loadFirstPage: () => Promise<void>): void {
  if (sessionListRefreshTimer) clearTimeout(sessionListRefreshTimer);
  sessionListRefreshTimer = setTimeout(() => {
    sessionListRefreshTimer = null;
    void loadFirstPage();
  }, SESSION_LIST_REFRESH_MS);
}

/**
 * Minimum slice of the session-list store this handler depends on.
 * Kept as an interface so the handler stays a pure function and tests
 * don't need to spin up zustand.
 */
export interface InboxStore {
  rows: ReadonlyArray<{ id: string }>;
  patchRow: (sessionId: string, patch: { has_unread: boolean }) => void;
  loadFirstPage: () => Promise<void>;
}

interface HandleInboxEnvelopeOptions {
  /** Called for message pings (not read); used to SUB session/live on inbox activity. */
  onMessagePing?: (sessionId: string) => void;
}

export function handleInboxEnvelope(
  env: InboxEnvelope,
  expectedUserId: string,
  store: InboxStore,
  logger: Pick<Console, "warn"> = console,
  options?: HandleInboxEnvelopeOptions,
): void {
  const prefix = "inbox/";
  if (!env.topic.startsWith(prefix)) return; // not for us, silently skip
  const topicUser = env.topic.slice(prefix.length);
  if (topicUser !== expectedUserId) {
    logger.warn("[inbox] ping for different user", { topicUser, expectedUserId });
    return;
  }

  let payload: InboxPing;
  try {
    const text = new TextDecoder().decode(new Uint8Array(env.bytes));
    payload = JSON.parse(text);
  } catch (e) {
    logger.warn("[inbox] failed to parse payload", e);
    return;
  }
  if (!payload || typeof payload.session_id !== "string") {
    logger.warn("[inbox] missing session_id", payload);
    return;
  }

  if (payload.type === "read") {
    // Another device marked this session read — clear the unread dot locally.
    store.patchRow(payload.session_id, { has_unread: false });
    return;
  }

  // type === "message" or absent (legacy) — mark session unread unless viewing.
  const found = store.rows.some((r) => r.id === payload.session_id);
  const isActiveView = !shouldMarkSessionUnread(payload.session_id);
  if (found) {
    if (isActiveView) {
      // Persist read marker first, then reload — avoids loadFirstPage racing
      // ahead of markSessionViewed and re-applying hasUnread from the server.
      scheduleMarkActiveSessionRead(payload.session_id, null, {
        afterMarkRead: () => void store.loadFirstPage(),
      });
    } else {
      // Instant unread dot; preview + last_message_at come from debounced reload.
      store.patchRow(payload.session_id, { has_unread: true });
    }
  }

  options?.onMessagePing?.(payload.session_id);
  if (!found || !isActiveView) {
    scheduleSessionListRefresh(() => store.loadFirstPage());
  }
}
