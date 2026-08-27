import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";

/** Match inbox list refresh debounce — coalesce burst mark-read calls. */
const MARK_ACTIVE_SESSION_READ_MS = 300;

/** True when the user is actively viewing this session (not archived overlay). */
export function isSessionActivelyViewed(sessionId: string): boolean {
  const { activeSessionId, viewingArchivedSessionId } =
    useSessionSelectionStore.getState();
  return (
    activeSessionId === sessionId && viewingArchivedSessionId !== sessionId
  );
}

export function shouldMarkSessionUnread(sessionId: string): boolean {
  return !isSessionActivelyViewed(sessionId);
}

interface PendingRead {
  timer: ReturnType<typeof setTimeout>;
  /** Captured at schedule time — mark-read still runs if user switches away mid-debounce. */
  scheduledWhileActive: boolean;
  lastReadMessageId: string | null;
}

const pendingBySession = new Map<string, PendingRead>();

/**
 * Debounced mark-read for messages arriving while the session is open.
 * Clears the local unread dot immediately; persists read marker after coalesce window.
 */
export function scheduleMarkActiveSessionRead(
  sessionId: string,
  lastReadMessageId?: string | null,
): void {
  const scheduledWhileActive = isSessionActivelyViewed(sessionId);
  if (!scheduledWhileActive) return;

  useSessionListStore.getState().patchRow(sessionId, { has_unread: false });

  const existing = pendingBySession.get(sessionId);
  if (existing) clearTimeout(existing.timer);

  const lastReadMessageIdNorm =
    lastReadMessageId != null && lastReadMessageId !== ""
      ? lastReadMessageId
      : (existing?.lastReadMessageId ?? null);

  pendingBySession.set(sessionId, {
    scheduledWhileActive: true,
    lastReadMessageId: lastReadMessageIdNorm,
    timer: setTimeout(() => {
      pendingBySession.delete(sessionId);
      void useSessionListStore
        .getState()
        .markSessionViewed(sessionId, lastReadMessageIdNorm);
    }, MARK_ACTIVE_SESSION_READ_MS),
  });
}

/** Test hook — clears pending debounced mark-read timers. */
export function resetActiveSessionReadForTests(): void {
  for (const entry of pendingBySession.values()) {
    clearTimeout(entry.timer);
  }
  pendingBySession.clear();
}
