import { shouldMarkSessionUnread } from "@/lib/session/active-session-read";
import { MessageKind } from "@/lib/proto/teamclu_pb";
import { useSessionListStore } from "@/stores/session-list-store";

/** Matches DB trigger `LEFT(content, 140)` on sessions.last_message_preview. */
export const SESSION_LIST_PREVIEW_MAX_LEN = 140;

export function truncateSessionListPreview(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, SESSION_LIST_PREVIEW_MAX_LEN);
}

export function messageKindUpdatesSessionPreview(kind: MessageKind): boolean {
  return kind === MessageKind.TEXT || kind === MessageKind.AGENT_REPLY;
}

/**
 * Optimistically sync sidebar preview + sort order.
 * Inbox reload remains the server source of truth for unread state.
 */
export function bumpSessionListLastMessage(
  sessionId: string,
  content: string | null | undefined,
  options?: { at?: string; markUnread?: boolean },
): void {
  const preview = truncateSessionListPreview(content ?? "");
  if (!preview) return;

  const markUnread =
    options?.markUnread ?? shouldMarkSessionUnread(sessionId);

  useSessionListStore.getState().bumpLastMessage(sessionId, {
    last_message_preview: preview,
    last_message_at: options?.at ?? new Date().toISOString(),
    has_unread: markUnread,
  });
}
