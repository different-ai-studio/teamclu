import { cloudApiBaseUrl } from "../../lib/cloud-api/client";
import { t } from "../../lib/i18n";
import { attachmentsFromMessage } from "./message-attachments";

export interface SessionSummary {
  sessionId: string;
  teamId: string;
  title: string;
  summary: string;
  participantCount: number;
  participantActorIds: string[];
  lastMessagePreview: string;
  lastMessageAt: string;
  createdAt: string;
  createdBy: string;
  hasUnread?: boolean;
  /** The idea this session belongs to; absent/empty for none. */
  ideaId?: string;
  /** The app this session was created from (`sessions.app_id`); absent/empty for none. */
  appId?: string;
  /** `user` | `cron` | `gateway` | `thread`; absent on older servers. */
  source?: string;
}

export type MessageAttachment = {
  url: string;
  path?: string;
  mime?: string;
  size?: number | null;
};

export interface SessionMessage {
  content: string;
  createdAt: string;
  kind: string;
  messageId: string;
  metadata: unknown | null;
  model: string;
  replyToMessageId: string;
  senderActorId: string;
  sessionId: string;
  teamId: string;
  turnId: string;
  attachments?: MessageAttachment[];
}

export interface SessionRecord {
  session_id: string | null;
  team_id: string | null;
  title: string | null;
  summary: string | null;
  participant_count: number | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string | null;
  created_by: string | null;
}

export interface MessageRecord {
  content: string | null;
  created_at: string | null;
  kind: string | null;
  metadata?: unknown | null;
  model: string | null;
  reply_to_message_id: string | null;
  sender_actor_id: string | null;
  session_id: string | null;
  team_id: string | null;
  turn_id: string | null;
  id: string | null;
  attachments?: unknown | null;
}

export interface SessionGroup {
  label: "Today" | "Yesterday" | "This Week" | "Earlier";
  sessions: SessionSummary[];
}

export interface SessionsListState {
  status: "idle" | "loading" | "empty" | "loaded" | "error" | "refreshing";
  sessions: SessionSummary[];
  groups: SessionGroup[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
}

// These are the raw persisted message rows for a session detail payload.
// Timeline/grouped presentation is derived later by the route/screen layer.
export type SessionMessageRows = SessionMessage[];

export type SessionDetailState =
  | {
      status: "loading";
      session: SessionSummary | null;
      messages: SessionMessageRows;
      errorMessage: null;
    }
  | {
      status: "not-found";
      session: null;
      messages: [];
      errorMessage: null;
    }
  | {
      status: "error";
      session: SessionSummary | null;
      messages: SessionMessageRows;
      errorMessage: string;
    }
  | {
      status: "empty";
      session: SessionSummary;
      messages: [];
      errorMessage: null;
    }
  | {
      status: "ready";
      session: SessionSummary;
      messages: SessionMessageRows;
      errorMessage: null;
    };

function normalizeTimestamp(value: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSessionTimestamp(session: SessionSummary): number {
  const lastMessageTimestamp = normalizeTimestamp(session.lastMessageAt);

  if (lastMessageTimestamp > 0) {
    return lastMessageTimestamp;
  }

  return normalizeTimestamp(session.createdAt);
}

export function mapSessionRecord(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.session_id ?? "",
    teamId: record.team_id ?? "",
    title: record.title ?? "",
    summary: record.summary ?? "",
    participantCount: record.participant_count ?? 0,
    participantActorIds: [],
    lastMessagePreview: record.last_message_preview ?? "",
    lastMessageAt: record.last_message_at ?? "",
    createdAt: record.created_at ?? "",
    createdBy: record.created_by ?? "",
  };
}

/** The Cloud API origin, or null where none is configured (tests). */
function attachmentBaseUrl(): string | null {
  try {
    return cloudApiBaseUrl();
  } catch {
    return null;
  }
}

export function mapMessageRecord(record: MessageRecord): SessionMessage {
  return {
    content: record.content ?? "",
    createdAt: record.created_at ?? "",
    kind: record.kind ?? "",
    messageId: record.id ?? "",
    metadata: record.metadata ?? null,
    model: record.model ?? "",
    replyToMessageId: record.reply_to_message_id ?? "",
    senderActorId: record.sender_actor_id ?? "",
    sessionId: record.session_id ?? "",
    teamId: record.team_id ?? "",
    turnId: record.turn_id ?? "",
    attachments: attachmentsFromMessage(record.metadata, record.attachments, attachmentBaseUrl()),
  };
}

export function buildSessionDetailState(
  session: SessionSummary,
  messageRows: SessionMessageRows,
): Extract<SessionDetailState, { status: "empty" | "ready" }> {
  if (messageRows.length === 0) {
    return {
      status: "empty",
      session,
      messages: [],
      errorMessage: null,
    };
  }

  return {
    status: "ready",
    session,
    messages: messageRows,
    errorMessage: null,
  };
}

function getSettledErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

export function reduceSessionDetailRouteState(
  sessionResult: PromiseSettledResult<SessionSummary | null>,
  messagesResult: PromiseSettledResult<SessionMessageRows>,
): Exclude<SessionDetailState, { status: "loading" }> {
  if (sessionResult.status === "fulfilled") {
    const session = sessionResult.value;

    if (!session) {
      return {
        status: "not-found",
        session: null,
        messages: [],
        errorMessage: null,
      };
    }

    if (messagesResult.status === "fulfilled") {
      return buildSessionDetailState(session, messagesResult.value);
    }

    return {
      status: "error",
      session,
      messages: [],
      errorMessage: getSettledErrorMessage(messagesResult.reason, t("Failed to load messages.")),
    };
  }

  return {
    status: "error",
    session: null,
    messages: [],
    errorMessage: getSettledErrorMessage(sessionResult.reason, t("Failed to load session.")),
  };
}

export type StreamingBuffer = {
  isComplete?: boolean;
  messageId: string;
  model?: string;
  text: string;
  kind: string;
  startedAt: string;
  senderActorId: string;
};

export type TimelineEvent =
  | { kind: "messageCommitted"; message: SessionMessage }
  | { kind: "streamingDelta";
      agentId: string; messageId: string; messageKind: string;
      deltaText: string; createdAt: string; isComplete?: boolean; model?: string; }
  | { kind: "streamingDone"; agentId: string; messageId: string };

export function groupSessionsByRecency(sessions: SessionSummary[], now = new Date()): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const dayOfWeek = now.getDay();
  const offsetFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfWeek = startOfToday - offsetFromMonday * 24 * 60 * 60 * 1000;
  const sortedSessions = [...sessions].sort((left, right) => getSessionTimestamp(right) - getSessionTimestamp(left));
  const today: SessionSummary[] = [];
  const yesterday: SessionSummary[] = [];
  const thisWeek: SessionSummary[] = [];
  const earlier: SessionSummary[] = [];

  for (const session of sortedSessions) {
    const timestamp = getSessionTimestamp(session);

    if (timestamp >= startOfToday) {
      today.push(session);
    } else if (timestamp >= startOfYesterday) {
      yesterday.push(session);
    } else if (timestamp >= startOfWeek) {
      thisWeek.push(session);
    } else {
      earlier.push(session);
    }
  }

  const groups: SessionGroup[] = [];
  if (today.length > 0) {
    groups.push({ label: "Today", sessions: today });
  }
  if (yesterday.length > 0) {
    groups.push({ label: "Yesterday", sessions: yesterday });
  }
  if (thisWeek.length > 0) {
    groups.push({ label: "This Week", sessions: thisWeek });
  }
  if (earlier.length > 0) {
    groups.push({ label: "Earlier", sessions: earlier });
  }

  return groups;
}
