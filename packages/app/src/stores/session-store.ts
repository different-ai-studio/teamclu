import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclu_pb";
import type { SessionErrorEvent } from "./session-types";
import { useSessionMessageStore } from "./session-message-store";
import { useSessionListStore } from "./session-list-store";
import { createLoaderActions } from "./session-loader";
import { createMessageActions } from "./session-messages";
import { useSessionSelectionStore } from "./session-selection-store";
import { useCurrentTeamStore } from "./current-team";

// ────────────────────────────────────────────────────────────────────
// v2 Phase 1 compat shim.
//
// Phase 1E removed the legacy session store but left ~167
// `@ts-expect-error Phase 1E removal` references across 26 production
// files (AppSidebar, ChatPanel, SessionList, etc) that read fields and
// call methods which no longer exist. Those calls crash on render.
//
// Until Phase 2 rewrites those consumers against the lean v2 stores,
// this shim exposes safe defaults so the app boots and the smoke-test
// path (login → pick session → send → MQTT round-trip) is reachable.
// Compat fields are typed as `any` via the Record<string, Compat>
// overlay so consumers compile without enumerating every prop. v2
// native fields keep their real types.
// ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Compat = any;

type V2Native = {
  messages: Record<string, Message[]>;
  currentSessionId: string | null;
  /** Bumped by reloadActiveSessionMessages so the App.tsx history loader
   * effect can detect a user-driven refresh and force a full pull. */
  messageRefreshTrigger: number;
  setCurrent: (sid: string | null) => void;
  appendMessage: (sid: string, msg: Message) => void;
  setMessages: (sid: string, msgs: Message[]) => void;
  currentMessages: () => Message[];
};

// Phase 1E compat fields explicitly typed so consumers' .map / .filter /
// .includes / [] indexing pass typecheck without per-callsite annotations.
// `Compat` (= any) keeps element shapes loose since the v1 shape is gone.
type CompatExplicit = {
  sessions: Compat[];
  archivedSessions: Compat[];
  pinnedSessionIds: string[];
  highlightedSessionIds: string[];
  pendingPermissions: Compat[];
  pendingQuestions: Compat[];
  messageQueue: Compat[];
  cronSessionIds: string[];
  sessionDiff: Compat[];
  pendingQuestionIdsBySession: Record<string, Compat>;
  sessionStatuses: Record<string, Compat>;
  todos: Compat[];
};

type SessionState = V2Native & CompatExplicit & { [key: string]: Compat };

const stub = (name: string) => (...args: Compat[]) => {
  if (typeof console !== "undefined") {
    console.warn(`[session-store stub] ${name} called (no-op in v2)`, args);
  }
};
const stubAsync = (name: string) => async (...args: Compat[]) => {
  if (typeof console !== "undefined") {
    console.warn(`[session-store stub] ${name} called (no-op in v2)`, args);
  }
};

export const useSessionStore = create<SessionState>((set, get) => ({
  // ── v2 native ────────────────────────────────────────────────────
  messages: {},
  currentSessionId: null,
  messageRefreshTrigger: 0,
  setCurrent: (sid) => {
    useSessionSelectionStore.getState().setCurrent(sid);
  },
  appendMessage: (sid, msg) => useSessionMessageStore.getState().appendMessage(sid, msg),
  setMessages: (sid, msgs) => useSessionMessageStore.getState().setMessages(sid, msgs),
  currentMessages: () => useSessionMessageStore.getState().currentMessages(),

  // ── Phase 1E compat: read-field defaults ─────────────────────────
  sessions: [],
  archivedSessions: [],
  activeSessionId: null,
  pinnedSessionIds: [],
  highlightedSessionIds: [],
  visibleSessionCount: 50,
  hasMoreSessions: false,
  isLoading: false,
  isLoadingMore: false,
  isLoadingArchivedSessions: false,
  archivedSessionError: null,
  sessionError: null,
  errorSessionId: null,
  inactivityWarning: null,
  isConnected: true,
  viewingArchivedSessionId: null,
  draftInput: "",
  messageQueue: [],
  pendingPermissions: [],
  pendingQuestions: [],
  pendingQuestionIdsBySession: {},
  answeredQuestionsByToolCallId: {},
  sessionStatuses: {},
  sessionStatus: null,
  cronSessionIds: [],
  todos: [],
  sessionDiff: [],

  // Re-enable the legacy chat/session pipeline on top of the v2 compat shim.
  ...createLoaderActions(set as never, get as never),
  ...createMessageActions(set as never, get as never),

  // ── Phase 1E compat: methods with light wiring ───────────────────
  getActiveSession: () => {
    const sid = get().currentSessionId ?? get().activeSessionId;
    if (!sid) return null;
    return get().sessions.find((s: Compat) => s.id === sid) ?? null;
  },
  setActiveSession: async (sid: string | null) => {
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
  setDraftInput: (text: string) => set({ draftInput: text }),
  setError: (msg: string | null, sid?: string | null) =>
    set({ sessionError: msg, errorSessionId: sid ?? null }),
  setSessionErrorEvent: (event: SessionErrorEvent) =>
    set({ sessionError: event, errorSessionId: event?.sessionId ?? null }),
  clearSessionError: () => set({ sessionError: null, errorSessionId: null }),
  toggleSessionPinned: (sid: string) => {
    const teamId = useCurrentTeamStore.getState().team?.id ?? null;
    useSessionListStore.getState().toggleSessionPinned(sid, teamId);
  },
  /** Briefly mark a session as freshly-created in the sidebar.
   * Auto-clears after ttlMs. */
  addHighlightedSession: (sid: string, ttlMs = 4000) => {
    useSessionListStore.getState().addHighlightedSession(sid, ttlMs);
  },
  setSelectedModel: (model: Compat) => set({ selectedModel: model }),
  setConnected: (v: boolean) => set({ isConnected: v }),
  setInactivityWarning: (v: Compat) => set({ inactivityWarning: v }),

  // ── Phase 1E compat: legacy pending-permission UI still calls replyPermission ──
  replyPermission: async (permissionId: string, decision: "allow" | "deny" | "always") => {
    const { replyPermissionById } = await import("@/lib/teamclu/reply-acp-permission");
    await replyPermissionById(permissionId, decision);
  },
  // ── opencode `question` tool ─────────────────────────────────────
  // question.asked arrives as a `question_asked` raw acp event (App.tsx),
  // parsed into PendingQuestionState here; QuestionCard renders on the tool
  // call and answers route back over the runtime command topic.
  addPendingQuestion: (question: Compat) =>
    set((s: Compat) => ({
      pendingQuestions: [
        ...s.pendingQuestions.filter((q: Compat) => q.questionId !== question.questionId),
        question,
      ],
    })),
  resolveQuestion: (questionId: string) =>
    set((s: Compat) => ({
      pendingQuestions: s.pendingQuestions.filter(
        (q: Compat) => q.questionId !== questionId,
      ),
    })),
  answerQuestion: async (answers: Record<string, string>, questionId?: string) => {
    const pending = get().pendingQuestions.find(
      (q: Compat) => !questionId || q.questionId === questionId,
    );
    if (!pending) {
      console.warn("[answerQuestion] no pending question", questionId);
      return;
    }
    // Record<questionId|index, label> → [[label], ...] in question order.
    const list: Compat[] = Array.isArray(pending.questions) ? pending.questions : [];
    const ordered: string[][] = list.map((q: Compat, idx: number) => {
      const key = q.id || String(idx);
      const answer = answers[key];
      return answer ? [answer] : [];
    });
    set((s: Compat) => ({
      answeredQuestionsByToolCallId: {
        ...(s.answeredQuestionsByToolCallId ?? {}),
        [pending.toolCallId]: { questions: list, answers },
      },
    }));
    const { answerAcpQuestion } = await import("@/lib/teamclu/answer-question");
    await answerAcpQuestion({
      sessionId: pending.sessionId ?? "",
      agentActorId: pending.agentActorId ?? "",
      requestId: pending.questionId,
      answers: ordered,
    });
    // Pi (and some backends) never emit question_replied — dismiss locally once
    // the command succeeds, same as skipQuestion.
    get().resolveQuestion(pending.questionId);
  },
  skipQuestion: async (questionId?: string) => {
    const pending = get().pendingQuestions.find(
      (q: Compat) => !questionId || q.questionId === questionId,
    );
    if (!pending) return;
    const list: Compat[] = Array.isArray(pending.questions) ? pending.questions : [];
    set((s: Compat) => ({
      answeredQuestionsByToolCallId: {
        ...(s.answeredQuestionsByToolCallId ?? {}),
        [pending.toolCallId]: { questions: list, answers: {} },
      },
    }));
    const { answerAcpQuestion } = await import("@/lib/teamclu/answer-question");
    await answerAcpQuestion({
      sessionId: pending.sessionId ?? "",
      agentActorId: pending.agentActorId ?? "",
      requestId: pending.questionId,
      answers: [],
      reject: true,
    });
    get().resolveQuestion(pending.questionId);
  },
  getSessionMessages: () => [],
  loadAllSessionMessages: stubAsync("loadAllSessionMessages"),
  handleMessageCreated: stub("handleMessageCreated"),
  handleMessagePartCreated: stub("handleMessagePartCreated"),
  handleMessagePartUpdated: stub("handleMessagePartUpdated"),
  handleMessageCompleted: stub("handleMessageCompleted"),
  handleToolExecuting: stub("handleToolExecuting"),
  handleQuestionAsked: stub("handleQuestionAsked"),
  handleTodoUpdated: stub("handleTodoUpdated"),
  handleSessionDiff: stub("handleSessionDiff"),
  handleFileEdited: stub("handleFileEdited"),
  handleSessionError: stub("handleSessionError"),
  handleSessionCreated: stub("handleSessionCreated"),
  handleSessionUpdated: stub("handleSessionUpdated"),
  handleExternalMessage: stub("handleExternalMessage"),
  handleSessionStatus: stub("handleSessionStatus"),
  handleSessionBusy: stub("handleSessionBusy"),
  handleSessionIdle: stub("handleSessionIdle"),
  handleChildSessionEvent: stub("handleChildSessionEvent"),
}));

// Adapt v2 SessionListEntry → old Session shape so consumers that read
// .updatedAt / .createdAt / .messages / .parentID don't crash.
function adaptSessionRow(r: Compat): Compat {
  const ts = r.last_message_at
    ? new Date(r.last_message_at)
    : new Date(0);
  return {
    ...r,
    updatedAt: ts,
    createdAt: ts,
    messages: [],
    parentID: null,
    ideaId: r.idea_id ?? null,
    source: r.source ?? undefined,
    cronJobId: r.cron_job_id ?? null,
  };
}

// Mirror useSessionListStore.rows → useSessionStore.sessions so old
// consumers reading `s.sessions` see a reactive list. Only push when
// values actually changed to avoid unnecessary re-render cascades.
useSessionListStore.subscribe((state, prev) => {
  const updates: Partial<SessionState> = {};
  if (state.rows !== prev.rows) updates.sessions = state.rows.map(adaptSessionRow);
  if (state.loading !== prev.loading) updates.isLoading = state.loading;
  if (state.pinnedSessionIds !== prev.pinnedSessionIds) {
    updates.pinnedSessionIds = state.pinnedSessionIds;
  }
  if (state.highlightedSessionIds !== prev.highlightedSessionIds) {
    updates.highlightedSessionIds = state.highlightedSessionIds;
  }
  if (state.hasMore !== prev.hasMore) updates.hasMoreSessions = state.hasMore;
  if (Object.keys(updates).length > 0) {
    useSessionStore.setState(updates);
  }
});
{
  const initial = useSessionListStore.getState();
  useSessionStore.setState({
    sessions: initial.rows.map(adaptSessionRow),
    isLoading: initial.loading,
    pinnedSessionIds: initial.pinnedSessionIds,
    highlightedSessionIds: initial.highlightedSessionIds,
    hasMoreSessions: initial.hasMore,
  });
}

useSessionSelectionStore.subscribe((state, prev) => {
  if (
    state.activeSessionId === prev.activeSessionId &&
    state.currentSessionId === prev.currentSessionId &&
    state.viewingArchivedSessionId === prev.viewingArchivedSessionId
  ) {
    return;
  }
  useSessionStore.setState({
    activeSessionId: state.activeSessionId,
    currentSessionId: state.currentSessionId,
    viewingArchivedSessionId: state.viewingArchivedSessionId,
  });
});
{
  const initial = useSessionSelectionStore.getState();
  useSessionStore.setState({
    activeSessionId: initial.activeSessionId,
    currentSessionId: initial.currentSessionId,
    viewingArchivedSessionId: initial.viewingArchivedSessionId,
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
