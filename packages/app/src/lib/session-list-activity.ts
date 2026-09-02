import type {
  PendingPermissionEntry,
  PendingQuestionState,
  Session,
} from "@/stores/session-types";
import type { SessionStatusInfo } from "@/stores/session-types";

type SessionActivityState = "running" | "waiting";
type SessionActivityKind = "streaming" | "retry" | "question" | "permission";

export interface SessionListActivity {
  state: SessionActivityState;
  kind: SessionActivityKind;
  count?: number;
}

type SessionStatusesById = Record<string, SessionStatusInfo | undefined>;
type PendingQuestionIdsBySession = Record<string, string[] | undefined>;

export function resolveSessionActivityOwner(
  sessionId: string | undefined | null,
  sessions: Pick<Session, "id" | "parentID">[],
  fallbackSessionId?: string | null,
): string | null {
  const startingId = sessionId || fallbackSessionId || null;
  if (!startingId) return null;

  const byId = new Map(sessions.map((session) => [session.id, session]));
  let currentId: string | null = startingId;
  const seen = new Set<string>();

  while (currentId) {
    if (seen.has(currentId)) return currentId;
    seen.add(currentId);

    const session = byId.get(currentId);
    if (!session?.parentID) return currentId;
    currentId = session.parentID;
  }

  return fallbackSessionId || startingId;
}

export function resolvePendingPermissionActivityOwner(
  entry: PendingPermissionEntry,
  sessions: Pick<Session, "id" | "parentID">[],
  fallbackSessionId?: string | null,
): string | null {
  if (entry.ownerSessionId) return entry.ownerSessionId;
  return resolveSessionActivityOwner(
    entry.childSessionId || entry.permission.sessionID,
    sessions,
    entry.permission.sessionID || fallbackSessionId,
  );
}

function pickHigherPriority(
  current: SessionListActivity | undefined,
  next: SessionListActivity,
): SessionListActivity {
  if (!current) return next;
  if (current.state === "waiting") {
    if (next.state === "waiting" && next.count && current.count) {
      return { ...current, count: Math.max(current.count, next.count) };
    }
    return current;
  }
  return next.state === "waiting" ? next : current;
}

function countQuestions(
  questions: PendingQuestionState[],
  sessionId: string,
): number {
  return questions
    .filter((question) => question.sessionId === sessionId)
    .reduce((total, question) => total + Math.max(1, question.questions.length), 0);
}

export function buildSessionListActivityMap({
  sessions,
  activeSessionId,
  sessionStatuses,
  pendingQuestionIdsBySession,
  pendingQuestions,
  pendingPermissions,
  streamingMessageId,
  streamingChildSessionIds,
}: {
  sessions: Pick<Session, "id" | "parentID">[];
  activeSessionId: string | null;
  sessionStatuses: SessionStatusesById;
  pendingQuestionIdsBySession: PendingQuestionIdsBySession;
  pendingQuestions: PendingQuestionState[];
  pendingPermissions: PendingPermissionEntry[];
  streamingMessageId: string | null;
  streamingChildSessionIds: string[];
}): Map<string, SessionListActivity> {
  const result = new Map<string, SessionListActivity>();

  const mark = (sessionId: string | undefined | null, activity: SessionListActivity) => {
    const owner = resolveSessionActivityOwner(sessionId, sessions, activeSessionId);
    if (!owner) return;
    result.set(owner, pickHigherPriority(result.get(owner), activity));
  };

  for (const [sessionId, status] of Object.entries(sessionStatuses)) {
    if (!status || status.type === "idle") continue;
    mark(sessionId, {
      state: status.type === "retry" ? "waiting" : "running",
      kind: status.type === "retry" ? "retry" : "streaming",
    });
  }

  for (const [sessionId, keys] of Object.entries(pendingQuestionIdsBySession)) {
    if (keys && keys.length > 0) {
      mark(sessionId, { state: "waiting", kind: "question", count: Math.max(1, keys.length) });
    }
  }

  for (const question of pendingQuestions) {
    const sessionId = question.sessionId || activeSessionId;
    mark(sessionId, {
      state: "waiting",
      kind: "question",
      count: Math.max(1, countQuestions(pendingQuestions, sessionId || "")),
    });
  }

  for (const permission of pendingPermissions) {
    mark(resolvePendingPermissionActivityOwner(permission, sessions, activeSessionId), {
      state: "waiting",
      kind: "permission",
    });
  }

  if (streamingMessageId && activeSessionId) {
    mark(activeSessionId, { state: "running", kind: "streaming" });
  }

  for (const childSessionId of streamingChildSessionIds) {
    mark(childSessionId, { state: "running", kind: "streaming" });
  }

  return result;
}
