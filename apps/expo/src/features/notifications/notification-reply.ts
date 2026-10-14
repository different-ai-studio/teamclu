import { uuidV4 } from "../../lib/uuid";

/**
 * Inline reply from a message notification (iOS #1709 `NotificationReply`).
 *
 * FC tags message pushes with the APNs category `SESSION_MESSAGE`; once the
 * app registers it, iOS shows a reply field on the notification. The reply is
 * written over HTTP only — the app may have been woken in the background with
 * no MQTT — and FC fans the row out to agent inboxes as usual (#1455).
 */
export const SESSION_MESSAGE_CATEGORY = "SESSION_MESSAGE";
export const SESSION_REPLY_ACTION = "SESSION_REPLY";

export type NotificationReplyRequest = {
  sessionId: string;
  teamId: string;
  /** The notified message; the reply quotes it. */
  messageId: string | null;
  senderActorId: string | null;
  /** An agent only answers when addressed, so an agent sender is @-ed. */
  senderIsAgent: boolean;
  text: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The reply in a notification response, or null for any other response. */
export function replyRequestFromResponse(response: unknown): NotificationReplyRequest | null {
  if (!isRecord(response) || response.actionIdentifier !== SESSION_REPLY_ACTION) return null;
  const text = typeof response.userText === "string" ? response.userText.trim() : "";
  if (!text) return null;
  const notification = isRecord(response.notification) ? response.notification : null;
  const request = notification && isRecord(notification.request) ? notification.request : null;
  const content = request && isRecord(request.content) ? request.content : null;
  const data = content && isRecord(content.data) ? content.data : null;
  if (!data) return null;
  const sessionId = str(data.session_id);
  const teamId = str(data.team_id);
  if (!sessionId || !teamId) return null;
  return {
    sessionId,
    teamId,
    messageId: str(data.message_id),
    senderActorId: str(data.sender_actor_id),
    senderIsAgent: str(data.sender_kind)?.toLowerCase() === "agent",
    text,
  };
}

export type NotificationReplyDeps = {
  getUserId: () => Promise<string | null>;
  resolveMemberActorId: (teamId: string, userId: string) => Promise<string | null>;
  insertOutgoingMessage: (input: {
    id: string;
    teamId: string;
    sessionId: string;
    senderActorId: string;
    content: string;
    createdAt: string;
    metadata: Record<string, unknown>;
    replyToMessageId: string | null;
  }) => Promise<void>;
  /** A reply that could not be sent is kept, not lost. */
  saveDraft: (sessionId: string, text: string) => Promise<void>;
  notifyFailure: (sessionId: string) => Promise<void>;
  now?: () => Date;
};

export async function sendNotificationReply(
  request: NotificationReplyRequest,
  deps: NotificationReplyDeps,
): Promise<"sent" | "savedAsDraft"> {
  try {
    const userId = await deps.getUserId();
    if (!userId) throw new Error("signed out");
    const actorId = await deps.resolveMemberActorId(request.teamId, userId);
    if (!actorId) throw new Error("no member actor in this team");
    const mentions =
      request.senderIsAgent && request.senderActorId ? [request.senderActorId] : [];
    await deps.insertOutgoingMessage({
      id: uuidV4(),
      teamId: request.teamId,
      sessionId: request.sessionId,
      senderActorId: actorId,
      content: request.text,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      metadata: { mention_actor_ids: mentions },
      replyToMessageId: request.messageId,
    });
    return "sent";
  } catch {
    await deps.saveDraft(request.sessionId, request.text).catch(() => {});
    await deps.notifyFailure(request.sessionId).catch(() => {});
    return "savedAsDraft";
  }
}
