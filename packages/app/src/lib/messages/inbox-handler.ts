// packages/app/src/lib/inbox-handler.ts
//
// Handles incoming MQTT pings on `inbox/<user_id>` (published by FC fan-out
// after each message INSERT or mark-viewed). The payload shape:
//   { type?: "message" | "read", session_id, kind?, mentioned?, ts }
// `type` is optional for backward compatibility — absent means "message".
// Attention badges need `kind`; without it (pre-attention FC) fall back to the
// legacy unread patch + current-list refresh so a client-only ship stays silent.

import {
  scheduleMarkActiveSessionRead,
  shouldMarkSessionUnread,
} from "@/lib/session/active-session-read";
import { mqttSubscribe } from "@/lib/mqtt/mqtt-bridge";
import { isSessionListKindValue } from "@/lib/session/session-list-attention";
import type { SessionListKind } from "@/lib/session/session-list-kind";
import { useCurrentTeamStore } from "@/stores/current-team";

interface InboxPing {
  session_id: string;
  team_id?: string;
  type?: "message" | "read" | "session.participants";
  kind?: string;
  mentioned?: boolean;
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
/**
 * Kinds accumulated during the debounce window for inbox attention refresh.
 * `pendingRefreshAny` covers legacy pings with no kind (reload the visible
 * list only). MQTT callers that only need a current-list reload set
 * `pendingReloadCurrent` via `scheduleSessionListRefresh`.
 */
let pendingRefreshKinds = new Set<SessionListKind>();
let pendingRefreshAny = false;
let pendingReloadCurrent = false;
let pendingInboxRefresh:
  | ((kinds?: SessionListKind[]) => void | Promise<void>)
  | null = null;
let pendingCurrentReload: (() => void | Promise<void>) | null = null;

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

function flushPendingSessionListRefresh(): void {
  sessionListRefreshTimer = null;
  const kinds = [...pendingRefreshKinds];
  const refreshAny = pendingRefreshAny;
  const reloadCurrent = pendingReloadCurrent;
  const inboxRefresh = pendingInboxRefresh;
  const currentReload = pendingCurrentReload;
  pendingRefreshKinds = new Set();
  pendingRefreshAny = false;
  pendingReloadCurrent = false;
  pendingInboxRefresh = null;
  pendingCurrentReload = null;

  if (inboxRefresh && (kinds.length > 0 || refreshAny)) {
    void inboxRefresh(kinds.length > 0 ? kinds : undefined);
  }
  if (reloadCurrent && currentReload) {
    void currentReload();
  }
}

function armSessionListRefreshTimer(): void {
  if (sessionListRefreshTimer) clearTimeout(sessionListRefreshTimer);
  sessionListRefreshTimer = setTimeout(
    flushPendingSessionListRefresh,
    SESSION_LIST_REFRESH_MS,
  );
}

/** Test hook — clears pending debounced refresh. */
export function resetSessionListRefreshForTests(): void {
  if (sessionListRefreshTimer) {
    clearTimeout(sessionListRefreshTimer);
    sessionListRefreshTimer = null;
  }
  pendingRefreshKinds = new Set();
  pendingRefreshAny = false;
  pendingReloadCurrent = false;
  pendingInboxRefresh = null;
  pendingCurrentReload = null;
  resetInboxSubscriptionState();
}

/** @deprecated Use resetSessionListRefreshForTests */
export const resetInboxListRefreshForTests = resetSessionListRefreshForTests;

/**
 * Debounced reload of the *currently visible* session list.
 * Used by MQTT live maintenance. Never switches `listKind`.
 */
export function scheduleSessionListRefresh(
  loadCurrentFirstPage: () => void | Promise<void>,
): void {
  pendingReloadCurrent = true;
  pendingCurrentReload = loadCurrentFirstPage;
  armSessionListRefreshTimer();
}

/**
 * Debounced inbox attention refresh. Never switches `listKind` — the store's
 * `refreshAfterInbox` reloads the visible kind only when it was touched, and
 * soft-fetches attention for foreign kinds.
 */
export function scheduleInboxAttentionRefresh(
  refreshAfterInbox: (kinds?: SessionListKind[]) => void | Promise<void>,
  kind?: SessionListKind,
): void {
  if (kind) pendingRefreshKinds.add(kind);
  else pendingRefreshAny = true;
  pendingInboxRefresh = refreshAfterInbox;
  armSessionListRefreshTimer();
}

/**
 * Minimum slice of the session-list store this handler depends on.
 * Kept as an interface so the handler stays a pure function and tests
 * don't need to spin up zustand.
 */
export interface InboxStore {
  rows: ReadonlyArray<{ id: string }>;
  patchRow: (
    sessionId: string,
    patch: { has_unread?: boolean; has_mention?: boolean },
  ) => void;
  /** Visible-list reload only — callers must not pass a foreign kind. */
  loadFirstPage: (limit?: number, kind?: SessionListKind) => Promise<void>;
  /**
   * Inbox-driven refresh that never switches `listKind`. Reloads the visible
   * kind when touched (or when `kinds` is omitted); soft-fetches attention for
   * every other touched kind.
   */
  refreshAfterInbox: (kinds?: SessionListKind[]) => void | Promise<void>;
  noteInboxMessage: (input: {
    sessionId: string;
    kind: SessionListKind;
    mentioned: boolean;
  }) => void;
  clearSessionAttention: (sessionId: string) => void;
}

interface HandleInboxEnvelopeOptions {
  /** Called for message pings (not read); used to SUB session/live on inbox activity. */
  onMessagePing?: (sessionId: string) => void;
  /** A roster hint. The handler returns before unread and message side effects. */
  onParticipantsChanged?: (sessionId: string, teamId: string) => void;
}

/**
 * Inbox is per-user, not per-team. Drop message/read pings for another team so
 * attention badges cannot stick on the active team's kind/nav map. Missing
 * `team_id` keeps the legacy path (pre-attention FC). No current team → allow
 * (fail open); dropping same-team pings while the store is briefly empty
 * blanks kind badges until the user clicks into that kind.
 */
function isInboxPingForActiveTeam(teamId: string | undefined): boolean {
  if (typeof teamId !== "string" || teamId.length === 0) return true;
  const currentTeamId = useCurrentTeamStore.getState().team?.id;
  if (!currentTeamId) return true;
  return teamId === currentTeamId;
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

  if (payload.type === "session.participants") {
    if (typeof payload.team_id === "string" && payload.team_id.length > 0) {
      options?.onParticipantsChanged?.(payload.session_id, payload.team_id);
    }
    return;
  }

  if (!isInboxPingForActiveTeam(payload.team_id)) {
    return;
  }

  if (payload.type === "read") {
    store.clearSessionAttention(payload.session_id);
    return;
  }

  // type === "message" or absent (legacy) — mark session unread unless viewing.
  const kind = isSessionListKindValue(payload.kind) ? payload.kind : null;
  const mentioned = payload.mentioned === true;
  const found = store.rows.some((r) => r.id === payload.session_id);
  const isActiveView = !shouldMarkSessionUnread(payload.session_id);

  if (isActiveView) {
    // Persist read marker first, then reload the *visible* list — never pass a
    // foreign kind into loadFirstPage (that switches listKind).
    scheduleMarkActiveSessionRead(payload.session_id, null, {
      afterMarkRead: () => void store.loadFirstPage(50),
    });
    options?.onMessagePing?.(payload.session_id);
    return;
  }

  if (kind) {
    store.noteInboxMessage({
      sessionId: payload.session_id,
      kind,
      mentioned,
    });
    options?.onMessagePing?.(payload.session_id);
    scheduleInboxAttentionRefresh(store.refreshAfterInbox, kind);
    return;
  }

  // Pre-attention FC: no kind → same unread path as main, no cross-kind badges.
  if (found) {
    store.patchRow(payload.session_id, { has_unread: true });
  }
  options?.onMessagePing?.(payload.session_id);
  scheduleInboxAttentionRefresh(store.refreshAfterInbox);
}
