import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionStore } from "@/stores/session-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useStreamingStore } from "@/stores/streaming";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";

/** Drop in-memory chat UI state when auth identity or active team changes. */
export function resetClientChatState(): void {
  useSessionSelectionStore.getState().clearActiveSession();
  useSessionMessageStore.setState({
    messages: {},
    messageRefreshTrigger: 0,
    messageRefreshForceFull: false,
  });
  useSessionListStore.setState({
    rows: [],
    loading: true,
    error: null,
    hasMore: false,
    nextCursor: null,
    listKind: "regular",
    regularHasMore: false,
    regularNextCursor: null,
    cronHasMore: false,
    cronNextCursor: null,
    highlightedSessionIds: [],
    // The list is team-scoped; clearing the scope alongside the rows is what
    // makes the next loadFirstPage re-fetch instead of treating the emptied
    // list as an already-loaded page for the team being left.
    //
    // `serverConfirmedTeams` is deliberately NOT cleared: it is keyed by team
    // and this runs on every team switch, so wiping it would throw away the
    // proof for teams that are not being left. Sign-out clears it (see
    // loadFirstPage's no-session branch), which is the point where a different
    // account makes it meaningless.
    scopeTeamId: null,
    loadedTeamId: null,
  });
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
  });
  useSessionStore.setState({
    sessions: [],
    draftInput: "",
    messageQueue: [],
    pendingPermissions: [],
    pendingQuestions: [],
    pendingQuestionIdsBySession: {},
    answeredQuestionsByToolCallId: {},
    sessionStatuses: {},
    sessionStatus: null,
    sessionError: null,
    errorSessionId: null,
    todos: [],
    sessionDiff: [],
  });
  useV2StreamingStore.setState({
    byKey: {},
    archived: [],
    persistedPlansBySession: {},
    interruptedFlushPending: {},
  });
  useStreamingStore.getState().clearStreaming();
  useStreamingStore.getState().clearAllChildStreaming();
  useEngagedAgentStore.setState({
    bySession: {},
  });
  useSessionNoticeStore.setState({ bySession: {} });
  useAgentModelPickStore.setState({ bySessionAgent: {} });
}
