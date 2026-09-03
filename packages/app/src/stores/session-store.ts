import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclu_pb";
import type {
  PendingPermissionEntry,
  PendingQuestionState,
  Question,
  QueuedMessage,
  Session,
  SessionErrorEvent,
  SessionStatusInfo,
} from "./session-types";
import { useSessionMessageStore } from "./session-message-store";
import { useSessionListStore, type SessionListEntry } from "./session-list-store";
import { useSessionSelectionStore } from "./session-selection-store";
import { useCurrentTeamStore } from "./current-team";

// ────────────────────────────────────────────────────────────────────
// Session store.
//
// The v2 stores own the session list (useSessionListStore), the selection
// (useSessionSelectionStore) and the message log (useSessionMessageStore).
// This store mirrors the slices of those that older chat consumers still read
// through one hook, and hosts the small amount of chat state that has no v2
// home yet: the composer draft, turn errors, and the `question` tool queue.
//
// Every field is typed. There is no index signature and no `any`: a consumer
// that reads a field which does not exist here fails to compile instead of
// silently reading `undefined`.
// ────────────────────────────────────────────────────────────────────

/** Q&A snapshot kept per tool call so Process cards stay populated after the answer. */
export interface AnsweredQuestionSnapshot {
  questions: Question[];
  answers: Record<string, string>;
}

export interface SessionState {
  // ── Mirrors of the v2 stores. Write to the source, never here. ──
  /** Mirror of useSessionMessageStore.messages. */
  messages: Record<string, Message[]>;
  /** Mirror of useSessionMessageStore.messageRefreshTrigger. Bumped by
   * reloadActiveSessionMessages so the App.tsx history loader can detect a
   * user-driven refresh and force a full pull. */
  messageRefreshTrigger: number;
  /** Mirror of useSessionSelectionStore.activeSessionId. */
  activeSessionId: string | null;
  /** Mirror of useSessionSelectionStore.currentSessionId. */
  currentSessionId: string | null;
  /** Mirror of useSessionListStore.rows adapted to the legacy Session shape
   * (`messages` is always empty and `parentID` always unset: the list store
   * carries neither). */
  sessions: Session[];
  /** Mirror of useSessionListStore.loading; loadSessions also drives it. */
  isLoading: boolean;

  // ── State hosted only here ──
  /** Plain error banner text shown above the composer. */
  error: string | null;
  /** Session the plain error belongs to, so other sessions do not show it. */
  errorSessionId: string | null;
  /** Structured agent-turn error rendered as a SessionErrorAlert bubble. */
  sessionError: SessionErrorEvent | null;
  /** Composer draft, preserved when navigating away from the chat. */
  draftInput: string;
  /** Open `question` tool prompts (question.asked), newest last. */
  pendingQuestions: PendingQuestionState[];
  answeredQuestionsByToolCallId: Record<string, AnsweredQuestionSnapshot>;
  /** Legacy permission.asked queue. Nothing produces entries any more: the v2
   * ACP path keeps permissions in useV2StreamingStore.pendingPermissionsByRequestId.
   * Kept typed because the legacy approval components and their tests still
   * read it; retire together with them. */
  pendingPermissions: PendingPermissionEntry[];
  /** Composer queue shown while an agent turn is running. Nothing produces
   * entries since the pre-outbox send path was removed. */
  messageQueue: QueuedMessage[];
  /** Per-session runtime status consumed by the sidebar activity map. No producer today. */
  sessionStatuses: Record<string, SessionStatusInfo | undefined>;
  /** Question ids per session consumed by the sidebar activity map. No producer today. */
  pendingQuestionIdsBySession: Record<string, string[] | undefined>;

  // ── Actions ──
  setCurrent: (sid: string | null) => void;
  appendMessage: (sid: string, msg: Message) => void;
  setMessages: (sid: string, msgs: Message[]) => void;
  currentMessages: () => Message[];
  /** The mirrored row for currentSessionId (falling back to activeSessionId). */
  getActiveSession: () => Session | null;
  setActiveSession: (sid: string | null) => Promise<void>;
  loadSessions: (workspacePath?: string) => Promise<void>;
  resetSessions: () => void;
  reloadActiveSessionMessages: () => Promise<void>;
  archiveSession: (sid: string) => Promise<void>;
  toggleSessionPinned: (sid: string) => void;
  /** Briefly mark a session as freshly created in the sidebar. Auto-clears after ttlMs. */
  addHighlightedSession: (sid: string, ttlMs?: number) => void;
  setDraftInput: (text: string) => void;
  setError: (msg: string | null, sid?: string | null) => void;
  /** Show a structured error alert (SessionErrorAlert) in a session's thread. */
  setSessionErrorEvent: (event: SessionErrorEvent) => void;
  clearSessionError: () => void;
  removeFromQueue: (id: string) => void;
  /** Legacy pending-permission UI entry point; the v2 path replies directly. */
  replyPermission: (
    permissionId: string,
    decision: "allow" | "deny" | "always",
  ) => Promise<void>;
  addPendingQuestion: (question: PendingQuestionState) => void;
  resolveQuestion: (questionId: string) => void;
  answerQuestion: (answers: Record<string, string>, questionId?: string) => Promise<void>;
  skipQuestion: (questionId?: string) => Promise<void>;
}

/** `Record<questionId|index, label>` → `[[label], ...]` in question order. */
function orderAnswers(questions: Question[], answers: Record<string, string>): string[][] {
  return questions.map((q, idx) => {
    const key = q.id || String(idx);
    const answer = answers[key];
    return answer ? [answer] : [];
  });
}

export const useSessionStore = create<SessionState>((set, get) => ({
  // ── mirrors ────────────────────────────────────────────────────────
  messages: {},
  messageRefreshTrigger: 0,
  activeSessionId: null,
  currentSessionId: null,
  sessions: [],
  isLoading: false,

  // ── hosted state ───────────────────────────────────────────────────
  error: null,
  errorSessionId: null,
  sessionError: null,
  draftInput: "",
  pendingQuestions: [],
  answeredQuestionsByToolCallId: {},
  pendingPermissions: [],
  messageQueue: [],
  sessionStatuses: {},
  pendingQuestionIdsBySession: {},

  // ── delegations to the v2 stores ───────────────────────────────────
  setCurrent: (sid) => {
    useSessionSelectionStore.getState().setCurrent(sid);
  },
  appendMessage: (sid, msg) => useSessionMessageStore.getState().appendMessage(sid, msg),
  setMessages: (sid, msgs) => useSessionMessageStore.getState().setMessages(sid, msgs),
  currentMessages: () => useSessionMessageStore.getState().currentMessages(),
  getActiveSession: () => {
    const sid = get().currentSessionId ?? get().activeSessionId;
    if (!sid) return null;
    return get().sessions.find((s) => s.id === sid) ?? null;
  },
  setActiveSession: async (sid) => {
    await useSessionSelectionStore.getState().setActiveSession(sid);
  },
  loadSessions: async () => {
    await useSessionListStore.getState().load();
  },
  reloadActiveSessionMessages: async () => {
    await useSessionMessageStore.getState().reloadActiveSessionMessages();
  },
  resetSessions: () => {
    useSessionSelectionStore.getState().clearActiveSession();
    set({ sessions: [] });
  },
  archiveSession: async (id) => {
    const wasActiveSession = useSessionSelectionStore.getState().activeSessionId === id;
    try {
      await useSessionListStore.getState().archiveSession(id);
      if (wasActiveSession) {
        await useSessionSelectionStore.getState().setActiveSession(null);
      }
      set((state) => ({
        pendingQuestions: state.pendingQuestions.filter((q) => q.sessionId !== id),
        pendingPermissions: state.pendingPermissions.filter(
          (entry) =>
            entry.childSessionId !== id &&
            entry.permission.sessionID !== id &&
            entry.ownerSessionId !== id,
        ),
        sessionError: wasActiveSession ? null : state.sessionError,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to archive session",
      });
    }
  },
  toggleSessionPinned: (sid) => {
    const teamId = useCurrentTeamStore.getState().team?.id ?? null;
    useSessionListStore.getState().toggleSessionPinned(sid, teamId);
  },
  addHighlightedSession: (sid, ttlMs = 4000) => {
    useSessionListStore.getState().addHighlightedSession(sid, ttlMs);
  },

  // ── hosted state actions ───────────────────────────────────────────
  setDraftInput: (text) => set({ draftInput: text }),
  setError: (msg, sid) => set({ error: msg, errorSessionId: sid ?? null }),
  setSessionErrorEvent: (event) =>
    set({ sessionError: event, errorSessionId: event?.sessionId ?? null }),
  clearSessionError: () => set({ sessionError: null, errorSessionId: null }),
  removeFromQueue: (id) =>
    set((state) => ({ messageQueue: state.messageQueue.filter((m) => m.id !== id) })),

  replyPermission: async (permissionId, decision) => {
    const { replyPermissionById } = await import("@/lib/teamclu/reply-acp-permission");
    await replyPermissionById(permissionId, decision);
  },

  // ── opencode `question` tool ─────────────────────────────────────
  // question.asked arrives as a `question_asked` raw acp event
  // (MqttLiveWiring), parsed into PendingQuestionState; QuestionCard renders
  // on the tool call and answers route back over the runtime command topic.
  addPendingQuestion: (question) =>
    set((s) => ({
      pendingQuestions: [
        ...s.pendingQuestions.filter((q) => q.questionId !== question.questionId),
        question,
      ],
    })),
  resolveQuestion: (questionId) =>
    set((s) => ({
      pendingQuestions: s.pendingQuestions.filter((q) => q.questionId !== questionId),
    })),
  answerQuestion: async (answers, questionId) => {
    const pending = get().pendingQuestions.find(
      (q) => !questionId || q.questionId === questionId,
    );
    if (!pending) {
      console.warn("[answerQuestion] no pending question", questionId);
      return;
    }
    const list: Question[] = Array.isArray(pending.questions) ? pending.questions : [];
    const { answerAcpQuestion } = await import("@/lib/teamclu/answer-question");
    await answerAcpQuestion({
      sessionId: pending.sessionId ?? "",
      agentActorId: pending.agentActorId ?? "",
      requestId: pending.questionId,
      answers: orderAnswers(list, answers),
    });
    set((s) => ({
      answeredQuestionsByToolCallId: {
        ...s.answeredQuestionsByToolCallId,
        [pending.toolCallId]: { questions: list, answers },
      },
    }));
    // Pi (and some backends) never emit question_replied — dismiss locally once
    // the command succeeds, same as skipQuestion.
    get().resolveQuestion(pending.questionId);
  },
  skipQuestion: async (questionId) => {
    const pending = get().pendingQuestions.find(
      (q) => !questionId || q.questionId === questionId,
    );
    if (!pending) return;
    const list: Question[] = Array.isArray(pending.questions) ? pending.questions : [];
    const { answerAcpQuestion } = await import("@/lib/teamclu/answer-question");
    await answerAcpQuestion({
      sessionId: pending.sessionId ?? "",
      agentActorId: pending.agentActorId ?? "",
      requestId: pending.questionId,
      answers: [],
      reject: true,
    });
    set((s) => ({
      answeredQuestionsByToolCallId: {
        ...s.answeredQuestionsByToolCallId,
        [pending.toolCallId]: { questions: list, answers: {} },
      },
    }));
    get().resolveQuestion(pending.questionId);
  },
}));

// ── Mirrors ──────────────────────────────────────────────────────────

/** Adapt a v2 SessionListEntry to the legacy Session shape consumers read. */
function adaptSessionRow(r: SessionListEntry): Session {
  const ts = r.last_message_at ? new Date(r.last_message_at) : new Date(0);
  return {
    id: r.id,
    title: r.title,
    messages: [],
    updatedAt: ts,
    createdAt: ts,
    ideaId: r.idea_id ?? null,
    source: (r.source as Session["source"] | null | undefined) ?? undefined,
    cronJobId: r.cron_job_id ?? null,
  };
}

// Only push when values actually changed to avoid re-render cascades.
useSessionListStore.subscribe((state, prev) => {
  const updates: Partial<SessionState> = {};
  if (state.rows !== prev.rows) updates.sessions = state.rows.map(adaptSessionRow);
  if (state.loading !== prev.loading) updates.isLoading = state.loading;
  if (Object.keys(updates).length > 0) {
    useSessionStore.setState(updates);
  }
});
{
  const initial = useSessionListStore.getState();
  useSessionStore.setState({
    sessions: initial.rows.map(adaptSessionRow),
    isLoading: initial.loading,
  });
}

useSessionSelectionStore.subscribe((state, prev) => {
  if (
    state.activeSessionId === prev.activeSessionId &&
    state.currentSessionId === prev.currentSessionId
  ) {
    return;
  }
  useSessionStore.setState({
    activeSessionId: state.activeSessionId,
    currentSessionId: state.currentSessionId,
  });
});
{
  const initial = useSessionSelectionStore.getState();
  useSessionStore.setState({
    activeSessionId: initial.activeSessionId,
    currentSessionId: initial.currentSessionId,
  });
}

useSessionMessageStore.subscribe((state, prev) => {
  if (
    state.messages === prev.messages &&
    state.messageRefreshTrigger === prev.messageRefreshTrigger
  ) {
    return;
  }
  useSessionStore.setState({
    messages: state.messages,
    messageRefreshTrigger: state.messageRefreshTrigger,
  });
});
{
  const initial = useSessionMessageStore.getState();
  useSessionStore.setState({
    messages: initial.messages,
    messageRefreshTrigger: initial.messageRefreshTrigger,
  });
}
