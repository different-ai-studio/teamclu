import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Archive, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import {
  cn,
  isTauri,
} from "@/lib/utils";
import { useSessionStore } from "@/stores/session";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useStreamingStore } from "@/stores/streaming";
import { useWorkspaceStore } from "@/stores/workspace";
import { useProviderStore } from "@/stores/provider";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useTeamModeStore } from "@/stores/team-mode";
import { useCurrentTeamStore } from "@/stores/current-team";
import { TEAMCLU_DIR, CONFIG_FILE_NAME, TEAM_REPO_DIR } from "@/lib/build-config";
import { adaptTeamcluMessages } from "@/lib/v2-message-adapter";
import { clearDeferredProcessCache } from "@/lib/lazy-process-parts";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag";
import { logExtMsgDiag } from "@/lib/extension-msg-diag";
import { isChromeExtension } from "@/lib/platform";
import { useSessionListStore } from "@/stores/session-list-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import {
  DRAFT_SESSION_PICK_KEY,
  useAgentModelPickStore,
} from "@/stores/agent-model-pick-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useUIStore } from "@/stores/ui";
import { getBackend } from "@/lib/backend";
import { resolveSessionActivityOwner } from "@/lib/session-list-activity";
import { selectSessionParentLinks } from "@/lib/session-parent-links";
import { isAgentActorType } from "@/lib/actor-type";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import { Button } from "@/components/ui/button";
import { createQuickSession, describeQuickSessionFailure, type QuickSessionFailureReason } from "@/lib/create-quick-session";
import { isSoloAgentSession } from "@/lib/session-empty-thread-starters";
import type { Message } from "@/stores/session";
import { ChatInputArea } from "./ChatInputArea";
import { SessionNoticeList } from "./SessionNoticeList";
import { useEngagedAgentRuntimeMap } from "@/hooks/use-engaged-agent-runtime-map";
import { useEngagedAgentUiStates } from "@/hooks/use-engaged-agent-ui-states";
import { useEnsureEngagedRuntimesOnSessionFocus } from "@/hooks/use-ensure-engaged-runtimes-on-session-focus";
import { useReensureRuntimesOnMqttReconnect } from "@/hooks/use-reensure-runtimes-on-mqtt-reconnect";
import {
  quickChatLocalDaemonAgent,
  quickChatWelcomeAgent,
  useQuickChatReadiness,
} from "@/hooks/use-quick-chat-readiness";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { MessageList, type MessageListHandle } from "./MessageList";
import { useChatSend } from "./use-chat-send";
import { renderChatEmptyState } from "./chat-empty-state";
import { SessionErrorAlert } from "./SessionErrorAlert";
import { isPersistentSessionTurnError } from "@/lib/agent-turn-error";
import { hasVisiblePendingPermissions } from "./PermissionCard";
import { collectAcpStreamingPermissions } from "@/lib/teamclu/acp-permission-entries";
import { useSessionPermissionMode } from "@/lib/session-permission-mode";
import { interruptAgentActor } from "@/lib/teamclu/interrupt-agent";
import { toast } from "sonner";
import { AcpStreamDebugPanel } from "./AcpStreamDebugPanel";
import { ThreadPanel } from "./ThreadPanel";
import { ThreadListPanel } from "./ThreadListPanel";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useThreadListPanelStore } from "@/stores/thread-list-panel-store";
import type { Todo } from "@/stores/session-types";
import {
  isStreamInterruptible,
  useV2StreamingStore,
  selectPersistedPlanForSession,
  type StreamingPlanEntry,
} from "@/stores/v2-streaming-store";
import { resolveSessionEstablishedModel } from "@/lib/session-established-model";
import {
  resolveAgentCatalogModels,
  localRecentModelFallback,
} from '@/lib/agent-model-fallback'
import { useLocalDaemonActorId } from "@/lib/daemon-agent-admin";
import { clientMruModels } from "@/stores/client-model-mru";
import { ensureParticipantModels } from "@/stores/participant-model-store";
import { useLocalDaemonCatalogStore } from "@/stores/local-daemon-catalog-store";
import {
  selectAgentModel,
  resolveRuntimeStateEntryForAgent,
  backendTypeFromRuntimeEntry,
} from "@/lib/runtime-state-resolve";
// xterm + its webgl/search addons are ~560KB of the startup chunk and are only
// needed once the terminal drawer is actually opened, so pay for them then.
const TerminalPanel = React.lazy(async () => ({
  default: (await import("@/components/terminal/TerminalPanel")).TerminalPanel,
}));
import { useTerminalStore } from "@/stores/terminal-store";
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_AGENTS: AttachedAgent[] = [];

// ─── Main component ────────────────────────────────────────────────────────

interface ChatPanelProps {
  /** Compact mode for side panel in file mode layout */
  compact?: boolean;
}

export function ChatPanel({ compact = false }: ChatPanelProps) {
  const { t } = useTranslation();

  // ── UI store selectors ───────────────────────────────────────────────
  const draftPreselectedActor = useUIStore(s => s.draftPreselectedActor);

  // ── Session store selectors (reactive state only) ────────────────────
  const activeSessionId = useSessionSelectionStore(s => s.activeSessionId);
  const ensureParticipants = useSessionParticipantStore(s => s.ensureParticipants);
  const sessionPermissionMode = useSessionPermissionMode(activeSessionId);

  React.useEffect(() => {
    if (!activeSessionId) return;
    void ensureParticipants([activeSessionId]);
  }, [activeSessionId, ensureParticipants]);

  const error = useSessionStore(s => s.error);
  const errorSessionId = useSessionStore(s => s.errorSessionId);
  const isConnected = useSessionStore(s => s.isConnected);
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId);
  const messageQueue = useSessionStore(s => s.messageQueue);
  const sessionError = useSessionStore(s => s.sessionError);
  const inactivityWarning = useSessionStore(s => s.inactivityWarning);
  const todos = useSessionStore(s => s.todos);
  const pendingPermissions = useSessionStore(s => s.pendingPermissions);
  const pendingQuestions = useSessionStore(s => s.pendingQuestions);
  // Only id/parentID — ignore unrelated session field writes (title, preview, …).
  const sessionParentLinksKey = useSessionStore((s) =>
    s.sessions.map((row) => `${row.id}:${row.parentID ?? ""}`).join("|"),
  );
  const sessionParentLinks = React.useMemo(
    () => selectSessionParentLinks(useSessionStore.getState().sessions),
    // sessionParentLinksKey is the change signal; `sessions` is read through
    // getState() so unrelated row writes don't rebuild this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionParentLinksKey],
  );
  // Fingerprint embedded tool-call permissions on the active session so we
  // recompute showInlineTodo without subscribing to the full sessions array.
  const activeToolPermissionSig = useSessionStore((s) => {
    if (!activeSessionId) return "";
    const session = s.sessions.find((row) => row.id === activeSessionId);
    if (!session) return "";
    const ids: string[] = [];
    for (const message of session.messages || []) {
      for (const toolCall of message.toolCalls || []) {
        const permission = toolCall.permission;
        if (!permission || permission.decision !== "pending") continue;
        if (toolCall.status !== "calling" && toolCall.status !== "waiting") continue;
        ids.push(permission.id);
      }
    }
    return ids.join(",");
  });

  // ── V2 agent streaming (acp.event deltas) ───────────────────────────
  // Render ALL bubbles for the active session — current turn (active or
  // finalized) plus any archived prior turns. The daemon only persists
  // AGENT_REPLY to Supabase, so thinking + tool_calls + plan only survive
  // in the in-memory streaming entry. Filtering by `active` would make
  // them vanish the moment the turn finished. The bubble itself suppresses
  // the outputText after finalize so the persisted AGENT_REPLY ChatMessage
  // doesn't render the reply twice.
  const v2ActiveSessionRevision = useV2StreamingStore((s) =>
    activeSessionId ? (s.revisionBySession[activeSessionId] ?? 0) : 0,
  );
  const persistedSessionPlan = useV2StreamingStore((s) =>
    selectPersistedPlanForSession(s, activeSessionId),
  );
  const v2Streams = React.useMemo(() => {
    const s = useV2StreamingStore.getState();
    const current = Object.values(s.byKey).filter(
      (e) => e.sessionId === activeSessionId,
    );
    const archived = s.archived.filter((e) => e.sessionId === activeSessionId);
    return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
    // v2ActiveSessionRevision is the change signal; byKey/archived are read via
    // getState() to avoid re-subscribing to the whole store (perf). Do not add
    // byKey/archived to deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2ActiveSessionRevision, activeSessionId]);

  // Plan entries from the active agent's stream surface in the TodoList dock
  // above the prompt input (v1 style) rather than inline in the message
  // bubble. Render only the most-recently-updated stream's plan to avoid
  // stacking plans from multiple engaged agents — typical sessions have
  // one planner at a time. Mapped to the Todo shape the TodoList consumes.
  const planTodos = React.useMemo((): Todo[] => {
    const mapPlan = (
      entries: StreamingPlanEntry[],
      actorId: string,
    ): Todo[] =>
      entries.map((e, i) => ({
        id: `plan:${actorId}:${i}`,
        status: e.status,
        content: e.content,
        priority: e.priority,
      }));

    const latestWithPlan = [...v2Streams]
      .reverse()
      .find((entry) => entry.planEntries.length > 0);
    if (latestWithPlan) {
      return mapPlan(latestWithPlan.planEntries, latestWithPlan.actorId);
    }
    if (persistedSessionPlan?.planEntries.length) {
      return mapPlan(
        persistedSessionPlan.planEntries,
        persistedSessionPlan.actorId,
      );
    }
    return [];
  }, [v2Streams, persistedSessionPlan]);

  // ── Archived session viewing ────────────────────────────────────────
  const viewingArchivedSessionId = useSessionStore(s => s.viewingArchivedSessionId);
  const archivedSessionMessages = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? (s.archivedSessionMessages[s.viewingArchivedSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const archivedSession = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? s.archivedSessions.find((session) => session.id === s.viewingArchivedSessionId)
      : undefined
  );
  const archivedSessionError = useSessionStore(s => s.archivedSessionError);
  const isViewingArchived = !!viewingArchivedSessionId;

  const acpPendingForTodo = React.useMemo(
    () =>
      collectAcpStreamingPermissions(
        activeSessionId,
        useV2StreamingStore.getState().byKey,
      ),
    // v2ActiveSessionRevision is the change signal; byKey is read via getState()
    // to avoid re-subscribing to the whole store (perf). Do not add byKey to
    // deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, v2ActiveSessionRevision],
  );
  const showInlineTodo = React.useMemo(() => {
    if (isViewingArchived) return false;
    if (todos.length === 0 && messageQueue.length === 0 && planTodos.length === 0)
      return false;
    return !hasVisiblePendingPermissions(
      activeSessionId,
      useSessionStore.getState().sessions,
      pendingPermissions,
      acpPendingForTodo,
      sessionPermissionMode,
    );
    // activeToolPermissionSig / sessionParentLinks are change signals for the
    // getState() read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSessionId,
    acpPendingForTodo,
    activeToolPermissionSig,
    isViewingArchived,
    messageQueue.length,
    pendingPermissions,
    sessionPermissionMode,
    sessionParentLinks,
    todos,
    planTodos.length,
  ]);

  // Render order: planTodos first (live, being worked on) then static todos.
  // Dedup pass not needed — plan ids are namespaced `plan:` while todos use
  // their own id space.
  const combinedTodos = React.useMemo(
    () => (planTodos.length > 0 ? [...planTodos, ...todos] : todos),
    [planTodos, todos],
  );
  const hasComposerPlanData =
    !isViewingArchived &&
    (combinedTodos.length > 0 || messageQueue.length > 0);
  const activeInputQuestion = React.useMemo(() => {
    if (!activeSessionId) return null;
    if (isViewingArchived) return null;
    return (
      pendingQuestions.find((question) => {
        if (!question.sessionId) return true;
        return (
          resolveSessionActivityOwner(
            question.sessionId,
            sessionParentLinks,
            question.sessionId,
          ) === activeSessionId
        );
      }) ||
      null
    );
  }, [
    activeSessionId,
    isViewingArchived,
    pendingQuestions,
    sessionParentLinks,
  ]);

  // Actions — accessed via getState() to avoid creating subscriptions.
  // Zustand actions are stable references; subscribing to them wastes equality checks.
  const acts = useSessionStore.getState();
  const removeFromQueue = acts.removeFromQueue;

  const handleInterruptAgent = React.useCallback(
    (agentActorId: string) => {
      if (!activeSessionId) return;
      void (async () => {
        try {
          await interruptAgentActor({
            sessionId: activeSessionId,
            agentActorId,
          });
        } catch (error) {
          toast.error(
            t("chat.interruptFailed", "无法打断 agent 回复"),
            {
              description:
                error instanceof Error ? error.message : String(error),
            },
          );
        }
      })();
    },
    [activeSessionId, t],
  );

  const loadSessions = acts.loadSessions;
  const resetSessions = acts.resetSessions;
  const clearSessionError = acts.clearSessionError;
  const setError = acts.setError;
  const setStoreSelectedModel = acts.setSelectedModel;
  const closeArchivedSession = acts.closeArchivedSession;
  const restoreSession = acts.restoreSession;

  // ── Workspace store ───────────────────────────────────────────────────
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  // Keep local semaphores that simply mirror "workspace is set"; the legacy
  // separate bootstrapped vs ready flags collapsed into one signal.
  const workspaceBootstrapped = !!workspacePath;
  const workspaceReady = !!workspacePath;
  const currentWorkspaceId = workspacePath ?? "";
  const terminalOpen = useTerminalStore(
    s => Boolean(currentWorkspaceId && s.panelOpenByWorkspace[currentWorkspaceId]),
  );
  const terminalPanelHeight = useTerminalStore(
    s => currentWorkspaceId ? s.panelHeightByWorkspace[currentWorkspaceId] ?? 240 : 240,
  );
  const terminalBottomOffset = terminalOpen && workspacePath ? terminalPanelHeight : 0;

  // ── Local state ───────────────────────────────────────────────────────
  // draftInput lives in ChatInputArea (store subscription) so typing does not
  // re-render this panel / MessageList.
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  // engagedAgents is per-session: each @-mentioned agent shows as a pill in
  // the prompt-input toolbar. Switching away from a session and back
  // restores its engaged set rather than carrying one across sessions.
  // Draft-first chats (no session yet) surface the preselected agent as a
  // synthetic pill so the composer matches what first-send will create.
  const sessionEngagedAgents = useEngagedAgentStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] ?? EMPTY_AGENTS : EMPTY_AGENTS,
  );
  const engagedAgents = React.useMemo(() => {
    if (sessionEngagedAgents.length > 0) return sessionEngagedAgents;
    if (
      !activeSessionId &&
      draftPreselectedActor?.kind === 'agent'
    ) {
      return [
        {
          id: draftPreselectedActor.id,
          displayName: draftPreselectedActor.displayName,
        },
      ];
    }
    return EMPTY_AGENTS;
  }, [activeSessionId, draftPreselectedActor, sessionEngagedAgents]);
  const engagedAgentIds = React.useMemo(
    () => engagedAgents.map((a) => a.id),
    [engagedAgents],
  );
  const activeStreamingAgentIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const entry of v2Streams) {
      if (isStreamInterruptible(entry)) ids.add(entry.actorId);
    }
    return ids;
  }, [v2Streams]);
  const { agentToRuntimeId, agentToBackendType } = useEngagedAgentRuntimeMap(
    activeSessionId,
    engagedAgentIds,
  );
  const agentUiContext = React.useMemo(
    () => activeSessionId
      ? ({ kind: 'session', sessionId: activeSessionId } as const)
      : ({ kind: 'draft' } as const),
    [activeSessionId],
  );
  const engagedUiEntries = useEngagedAgentUiStates(
    engagedAgents,
    agentToRuntimeId,
    activeStreamingAgentIds,
    agentUiContext,
  );

  const sessionParticipants = useSessionParticipantStore((s) =>
    activeSessionId ? s.participantsBySession[activeSessionId] : undefined,
  );
  const participantsLoading = useSessionParticipantStore((s) =>
    activeSessionId ? s.loadingBySession[activeSessionId] ?? false : false,
  );
  const isSoloAgentSessionActive = React.useMemo(
    () =>
      sessionParticipants && !participantsLoading
        ? isSoloAgentSession(
            sessionParticipants.map((p) => ({
              isAgent: p.isAgent,
              isExternal: p.isExternal,
            })),
          )
        : false,
    [sessionParticipants, participantsLoading],
  );

  // Re-fetch after roster invalidation (e.g. second agent invited → solo unlocks).
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (sessionParticipants !== undefined || participantsLoading) return;
    void ensureParticipants([activeSessionId]);
  }, [activeSessionId, sessionParticipants, participantsLoading, ensureParticipants]);

  // `session_participants.model` — the authoritative per-session model
  // (ADR-0005/0007). Separate from the roster fetch above, which reads the
  // actor directory and carries no working state. Fire-and-forget: the
  // resolver falls through to the transcript scan and the retain until it
  // lands, so nothing here blocks the pill.
  React.useEffect(() => {
    ensureParticipantModels(activeSessionId);
  }, [activeSessionId]);

  const prevActiveSessionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevActiveSessionRef.current;
    if (prev && prev !== activeSessionId) {
      useSessionNoticeStore.getState().clearSession(prev);
    }
    prevActiveSessionRef.current = activeSessionId;
  }, [activeSessionId]);
  const addAgentForSession = React.useCallback(
    (agent: AttachedAgent) => {
      const sid = useSessionSelectionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().addAgent(sid, agent);
    },
    [],
  );
  const removeAgentForSession = React.useCallback(
    (agentId: string) => {
      if (isSoloAgentSessionActive) return;
      const sid = useSessionSelectionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().removeAgent(sid, agentId);
    },
    [isSoloAgentSessionActive],
  );
  const handleSwitchToLocalAgent = React.useCallback(
    (local: AttachedAgent) => {
      if (!activeSessionId) return;
      for (const entry of engagedUiEntries) {
        if (
          entry.uiState === "offline" ||
          entry.uiState === "stale" ||
          entry.uiState === "connecting" ||
          entry.uiState === "runtime-error"
        ) {
          // Same cleanup the pill's own X does (AgentSelectorDock onRemove):
          // a dropped agent's model pick must not outlive it, or the local
          // agent inherits the dead remote's model.
          useAgentModelPickStore.getState().clearPick(activeSessionId, entry.agent.id);
          removeAgentForSession(entry.agent.id);
        }
      }
      addAgentForSession(local);
      // Engaging via the mention pill starts a runtime; switching must too.
      // The local agent's real model only reaches the UI on its RuntimeInfo
      // retain, so without this the pill has nothing to show and falls through
      // to a positional default.
      const teamId =
        useSessionListStore.getState().rows.find((r) => r.id === activeSessionId)?.team_id ??
        useCurrentTeamStore.getState().team?.id ??
        null;
      if (!teamId) return;
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId,
          agentActorIds: [local.id],
          reason: "switch_to_local_agent",
        });
      });
    },
    [activeSessionId, engagedUiEntries, removeAgentForSession, addAgentForSession],
  );

  // Solo sessions (1 human + 1 agent): always show the agent pill so sends
  // route WYSIWYG. Re-engage whenever the pill is missing. When a second
  // agent (or member) joins, roster updates → no longer solo → pill unlocks.
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (engagedAgents.length > 0) return;

    const ensureRuntime = (agentActorId: string) => {
      const teamId =
        useSessionListStore.getState().rows.find((r) => r.id === activeSessionId)?.team_id ??
        useCurrentTeamStore.getState().team?.id ??
        null;
      if (!teamId) return;
      // Start on the model this session has already been running, not on
      // whatever the device MRU offers. Opening a cron session used to spawn a
      // second runtime on the daemon's default model, and since the pill
      // reports the live runtime, a job pinned to Haiku read as "Big Pickle" —
      // and the next message really would have run on it.
      const established =
        resolveSessionEstablishedModel(
          useSessionMessageStore.getState().messages[activeSessionId],
          agentActorId,
        )?.trim() || undefined;
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId,
          agentActorIds: [agentActorId],
          modelId: established,
          reason: "session_auto_engage",
        });
      });
    };

    const engageFromRoster = (
      roster: Array<{
        isAgent: boolean;
        isExternal?: boolean;
        actorId: string;
        displayName: string;
      }>,
    ) => {
      if (!isSoloAgentSession(roster)) return false;
      const sole = roster.find((p) => p.isAgent);
      if (!sole) return false;
      useEngagedAgentStore.getState().setAgents(activeSessionId, [{
        id: sole.actorId,
        displayName: sole.displayName || "AI",
        // Nobody chose this: it is the solo-session default, re-applied
        // whenever the pill is cleared.
        auto: true,
      }]);
      ensureRuntime(sole.actorId);
      return true;
    };

    // Same rule as resolve-session-mention-ids: an empty roster means the cache
    // has not answered yet, so fall through to the cloud read below instead of
    // concluding this session has no agent to engage.
    if (sessionParticipants !== undefined && sessionParticipants.length > 0) {
      engageFromRoster(sessionParticipants);
      return;
    }

    let cancelled = false;
    void (async () => {
      let actors: Awaited<ReturnType<ReturnType<typeof getBackend>['sessionMembers']['listParticipants']>>;
      try {
        actors = await getBackend().sessionMembers.listParticipants(activeSessionId);
      } catch {
        return;
      }
      if (cancelled) return;
      engageFromRoster(
        actors.map((row) => ({
          isAgent: isAgentActorType(row.actor_type),
          isExternal: row.actor_type === "external",
          actorId: row.id,
          displayName: row.display_name?.trim() || "AI",
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, engagedAgents.length, sessionParticipants]);

  const sessionRow = useSessionListStore(s => s.rows.find(r => r.id === activeSessionId));
  // Team is workspace-scoped: every session in `rows` shares the same team_id.
  // When activeSessionId is null (brand-new chat), fall back to any row's
  // team_id so SessionActorSheet still has a team context for the add flow.
  const currentTeamId = useCurrentTeamStore(s => s.team?.id ?? null);
  const fallbackTeamId = useSessionListStore(s => s.rows[0]?.team_id ?? null);
  const sheetTeamId = sessionRow?.team_id ?? fallbackTeamId ?? currentTeamId;
  useEnsureEngagedRuntimesOnSessionFocus({
    sessionId: activeSessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });
  useReensureRuntimesOnMqttReconnect({
    sessionId: activeSessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });

  const handleRetryOfflineAgents = React.useCallback(() => {
    if (!activeSessionId || !sheetTeamId) return;
    const offlineIds = engagedUiEntries
      .filter((e) => e.uiState === "offline" || e.uiState === "runtime-error")
      .map((e) => e.agent.id);
    if (offlineIds.length === 0) return;
    void import("@/lib/teamclu/runtime-ensure-scheduler").then(({ resetRuntimeEnsureThrottle }) => {
      resetRuntimeEnsureThrottle();
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId: sheetTeamId,
          agentActorIds: offlineIds,
          reason: "offline_banner_retry",
        });
      });
    });
  }, [activeSessionId, sheetTeamId, engagedUiEntries]);

  const showQuickSessionFailure = React.useCallback(
    (reason: QuickSessionFailureReason) => {
      const { title, description } = describeQuickSessionFailure(reason, t);
      toast.error(title, {
        description,
        ...(reason === "no_agent"
          ? {
              action: {
                label: t("chat.quickSessionSetDefaultAgent", "去设置默认 Agent"),
                onClick: () => useUIStore.getState().openSettings("daemonGeneral"),
              },
            }
          : {}),
      });
    },
    [t],
  );

  const quickChatState = useQuickChatReadiness();
  const { agent: welcomeQuickChatAgent, loading: welcomeQuickChatLoading } = React.useMemo(
    () => quickChatWelcomeAgent(quickChatState),
    [quickChatState],
  );
  const localDaemonAgent = React.useMemo(
    () => quickChatLocalDaemonAgent(quickChatState),
    [quickChatState],
  );
  const [welcomeSessionStarting, setWelcomeSessionStarting] = React.useState(false);

  const [isRestoringArchived, setIsRestoringArchived] = React.useState(false);
  const isRestoringArchivedRef = React.useRef(false);

  // ── Provider store ────────────────────────────────────────────────────
  const initProviderStore = useProviderStore(s => s.initAll);
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId);
  const runtimeModelSignature = useRuntimeStateStore((s) =>
    Object.entries(s.byRuntimeId)
      .map(([runtimeId, entry]) => {
        const models = entry.info.availableModels
          .map((model) => `${model.id}:${model.displayName}`)
          .join("|");
        return `${runtimeId}:${entry.info.agentType}:${entry.info.currentModel}:${models}`;
      })
      .sort()
      .join(";"),
  );

  // ── Active session model ──────────────────────────────────────────────
  // "Which model is this session on" has exactly one answer, produced by
  // `selectAgentModel` — the same resolver the AgentSelectorDock pill uses.
  // It is deliberately NOT mirrored into the provider store: a per-session
  // answer living in a workspace-global key is what made the pill and the send
  // path disagree on a freshly created session.
  const localDaemonActorId = useLocalDaemonActorId();
  const localDaemonCatalog = useLocalDaemonCatalogStore((s) => {
    const path = workspacePath?.trim();
    return path ? s.byWorkspacePath[path] : undefined;
  });
  const modelAgentId = engagedAgentIds[0] ?? "";
  // Draft chats have no session id yet; picks live in the draft scope until
  // `promoteDraftPicks` moves them across at create time.
  const modelPickScopeId = activeSessionId || DRAFT_SESSION_PICK_KEY;
  const activeEstablishedModel = useSessionMessageStore((s) =>
    activeSessionId && modelAgentId
      ? resolveSessionEstablishedModel(s.messages[activeSessionId], modelAgentId)
      : null,
  );
  // Subscribe so an explicit user pick re-renders — selectAgentModel reads the
  // same store through getState() and would otherwise miss the update.
  const activePickEntry = useAgentModelPickStore((s) =>
    modelAgentId ? s.bySessionAgent[`${modelPickScopeId}::${modelAgentId}`] : undefined,
  );
  const remoteDefaultCatalogModels = useRuntimeStateStore((s) =>
    modelAgentId ? s.defaultCatalogByActorId?.[modelAgentId]?.models : undefined,
  );
  const activeSessionModelId = React.useMemo(() => {
    if (!modelAgentId) return "";
    const available = resolveAgentCatalogModels({
      agentId: modelAgentId,
      localDaemonActorId,
      sessionId: activeSessionId,
      byRuntimeId: runtimeStates,
      runtimeInfo: resolveRuntimeStateEntryForAgent(modelAgentId, runtimeStates)?.info,
      localWorkspaceCatalogModels: localDaemonCatalog?.models,
      remoteDefaultCatalogModels,
    });
    return (
      selectAgentModel({
        sessionId: modelPickScopeId,
        agentId: modelAgentId,
        available,
        byRuntimeId: runtimeStates,
        providerFallback:
          localRecentModelFallback({
            agentId: modelAgentId,
            localDaemonActorId,
            // This client's MRU, keyed by the backend this agent runs on
            // (ADR-0007). `localDaemonCatalog` still supplies the catalog.
            // `sheetTeamId` resolves from the session list first. Leaving the
            // team to `current-team` alone read empty during cold start, and an
            // empty team is indistinguishable from "never picked a model".
            recentModels: clientMruModels(
              backendTypeFromRuntimeEntry(
                resolveRuntimeStateEntryForAgent(modelAgentId, runtimeStates),
              ),
              sheetTeamId,
            ),
            available,
          }) || undefined,
        sessionEstablishedModel: activeEstablishedModel,
      }).modelId || ""
    );
  }, [
    modelAgentId,
    modelPickScopeId,
    runtimeStates,
    localDaemonActorId,
    localDaemonCatalog,
    activeEstablishedModel,
    activePickEntry,
    remoteDefaultCatalogModels,
    sheetTeamId,
  ]);

  // ── Refs ───────────────────────────────────────────────────────────────
  const messageListRef = React.useRef<MessageListHandle>(null);

  // ── Derived values ────────────────────────────────────────────────────
  // v2: messages live in useSessionMessageStore.messages keyed by sessionId.
  // Adapt each Teamclu_Message → SDK Message shape so legacy MessageList
  // renders unchanged. Phase 2 will replace MessageList with native render.
  const activeMessagesRaw = useSessionMessageStore(s =>
    activeSessionId ? s.messages?.[activeSessionId] : undefined
  );
  const activeMessages = React.useMemo(
    () => adaptTeamcluMessages(activeMessagesRaw, { deferProcess: true }),
    [activeMessagesRaw],
  );
  /** Shown messages lag store during fade so old session can fade out before swap */
  const [displaySessionId, setDisplaySessionId] = React.useState<string | null>(activeSessionId);
  const [sessionFadeOpacity, setSessionFadeOpacity] = React.useState(1);
  const sessionsInSync = displaySessionId === activeSessionId;

  const displayMessagesRaw = useSessionMessageStore((s) =>
    !sessionsInSync && displaySessionId ? s.messages?.[displaySessionId] : undefined,
  );
  const displayOnlyMessages = React.useMemo(
    () =>
      sessionsInSync
        ? undefined
        : adaptTeamcluMessages(displayMessagesRaw, { deferProcess: true }),
    [sessionsInSync, displayMessagesRaw],
  );
  const displayMessages = sessionsInSync ? activeMessages : displayOnlyMessages;

  const activeStreamingAgents = React.useMemo(() => {
    const seen = new Set<string>();
    const agents: Array<{
      actorId: string;
      displayName?: string;
      entry: (typeof v2Streams)[number];
    }> = [];
    for (const entry of v2Streams) {
      if (!isStreamInterruptible(entry) || seen.has(entry.actorId)) continue;
      seen.add(entry.actorId);
      const engaged = engagedAgents.find((agent) => agent.id === entry.actorId);
      agents.push({
        actorId: entry.actorId,
        displayName: engaged?.displayName,
        entry,
      });
    }
    return agents;
  }, [v2Streams, engagedAgents]);

  const SESSION_FADE_MS = 150;

  React.useEffect(() => {
    if (activeSessionId === null) {
      setDisplaySessionId(null);
      setSessionFadeOpacity(1);
      // engagedAgent is per-session now; no need to clear here — the
      // selector returns null for null sessionId automatically.
    }
  }, [activeSessionId]);

  React.useEffect(() => {
    if (activeSessionId === null) return;
    if (displaySessionId === activeSessionId) return;
    if (displaySessionId === null) {
      setDisplaySessionId(activeSessionId);
      setSessionFadeOpacity(1);
      return;
    }
    setSessionFadeOpacity(0);
    const t = window.setTimeout(() => {
      if (displaySessionId) {
        clearDeferredProcessCache(displaySessionId);
      }
      setDisplaySessionId(activeSessionId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSessionFadeOpacity(1));
      });
    }, SESSION_FADE_MS);
    return () => clearTimeout(t);
  }, [activeSessionId, displaySessionId]);

  const isStreaming = !!streamingMessageId || activeStreamingAgents.length > 0;

  // ── Provider & Team mode init ──────────────────────────────────────
  // Merged to avoid race condition: team mode restarts the agent, which
  // would break a concurrent initProviderStore call.
  React.useEffect(() => {
    if (!workspaceReady) return;

    if (!workspacePath) {
      // No workspace yet, just init providers directly
      initProviderStore();
      return;
    }

    const { loadTeamConfig, applyTeamModel } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      // applyTeamModel is idempotent and self-noops when no team config is loaded.
      await applyTeamModel(workspacePath);
      initProviderStore();
    });
  }, [workspaceReady, workspacePath, initProviderStore]);

  React.useEffect(() => {
    if (!workspaceReady || !runtimeModelSignature) return;
    void initProviderStore();
  }, [workspaceReady, runtimeModelSignature, initProviderStore]);

  // NOTE: there used to be an effect here that resolved the session's model
  // from its `agent_runtimes` rows and wrote the answer back into the provider
  // store's global `currentModelKey`. It is gone on purpose. Writing a
  // per-session answer into a workspace-global key made the two disagree the
  // moment the effect could not run — a draft session has no `activeSessionId`,
  // so the key stayed on whatever the last workspace had persisted while the
  // pill resolved the session's real model independently. `selectAgentModel` is
  // the single resolver now; nothing mirrors its answer anywhere.

  // ── Team config hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;
    const isTauriEnv = isTauri();
    if (!isTauriEnv) return;

    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ path: string; kind: string }>('file-change', (event) => {
        const isTeamConfigChange = event.payload.path.includes(`${TEAMCLU_DIR}/${CONFIG_FILE_NAME}`);
        const isProviderMetaChange = event.payload.path.includes(`${TEAM_REPO_DIR}/_meta/provider.json`);
        if (!isTeamConfigChange && !isProviderMetaChange) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.log('[TeamMode] Team config changed, reloading team config');
          const store = useTeamModeStore.getState();
          const hadTeamConfig = store.teamModelConfig != null;
          await store.loadTeamConfig(workspacePath);
          const hasTeamConfig = useTeamModeStore.getState().teamModelConfig != null;

          if (hasTeamConfig) {
            await store.applyTeamModel(workspacePath);
          } else if (hadTeamConfig) {
            // Team config was cleared — refresh provider store so UI drops the team provider
            await useProviderStore.getState().initAll();
          }
        }, 1000);
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [workspaceReady, workspacePath]);

  // Sync the resolved session model to the session store. Its only reader is
  // the FileEditor "ask the agent" entry point (session-messages `sendMessage`).
  React.useEffect(() => {
    if (!activeSessionModelId) return;
    const idx = activeSessionModelId.indexOf("/");
    const providerID = idx > 0 ? activeSessionModelId.slice(0, idx) : "";
    const modelID = idx > 0 ? activeSessionModelId.slice(idx + 1) : activeSessionModelId;
    setStoreSelectedModel({ providerID, modelID, name: modelID });
  }, [activeSessionModelId, setStoreSelectedModel]);

  // Per-actor draft + voice insert live in ChatInputArea.

  // ── Auto-dismiss error banners after 5 seconds ─────────────────────────
  React.useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  React.useEffect(() => {
    if (!sessionError) return;
    // Persistent turn errors stay until dismiss or next send.
    if (isPersistentSessionTurnError(sessionError.error?.name)) return;
    const timer = setTimeout(() => clearSessionError(), 15000);
    return () => clearTimeout(timer);
  }, [sessionError, clearSessionError]);

  // SSE connection is managed by SSEProvider in App.tsx (persists across mode switches)

  // v2: pending permissions arrive on the ACP/MQTT stream — no HTTP poll fallback.

  // ── Session loading ───────────────────────────────────────────────────
  const prevWorkspaceRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;

    const isWorkspaceChange =
      prevWorkspaceRef.current !== null &&
      prevWorkspaceRef.current !== workspacePath;
    prevWorkspaceRef.current = workspacePath;

    let cancelled = false;
    void (async () => {
      if (isWorkspaceChange) {
        // Session list is team-scoped. Crossing workspaces must not always wipe
        // the active session: clicking a session in another workspace sets
        // selection first, then switches workspace in the background. Clearing
        // here would flash the welcome empty state until a second click.
        //
        // Preserve when the active session belongs to the *new* workspace
        // (session-driven switch). Clear when it does not (explicit workspace
        // switch from the local-agent card / settings).
        const activeId = useSessionSelectionStore.getState().activeSessionId;
        const teamId = useCurrentTeamStore.getState().team?.id;
        let preserve = false;
        if (activeId && teamId) {
          const { sessionBelongsToWorkspace } = await import("@/lib/session-by-workspace");
          preserve = await sessionBelongsToWorkspace(teamId, activeId, workspacePath);
        }
        if (cancelled) return;
        if (useWorkspaceStore.getState().workspacePath !== workspacePath) return;
        if (!preserve) {
          resetSessions();
        }
      }

      try {
        await loadSessions(workspacePath);
        if (!cancelled) setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          console.error("[ChatPanel] Failed to load sessions:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceBootstrapped, workspacePath, loadSessions, resetSessions, setError]);

  // NOTE: No polling fallback needed.
  // SSE /event endpoint streams ALL events (Bus.subscribeAll) including
  // session.created and session.updated, which are handled as global events
  // in the SSE client. The SSE connection is established as soon as baseUrl
  // is available, regardless of whether a session is active.

  // ── Input height change → forward to MessageList ───────────────────────
  const handleInputHeightChange = React.useCallback((height: number) => {
    messageListRef.current?.handleInputHeightChange(height);
  }, []);

  const handleComposerFocus = React.useCallback(() => {
    messageListRef.current?.pauseAutoFollowIfReading();
  }, []);

  // ── File handling ─────────────────────────────────────────────────────

  const appendPendingFiles = (files: File[]) => {
    setPendingFiles((prev) => [...prev, ...files]);
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Submit handler ────────────────────────────────────────────────────

  const { handleSubmit, createSessionAndSendFirst } = useChatSend({
    t,
    activeSessionId,
    displaySessionId,
    setDisplaySessionId,
    setSessionFadeOpacity,
    draftPreselectedActor,
    clearSessionError,
    pendingFiles,
    setPendingFiles,
    engagedAgents,
    engagedUiEntries,
    sheetTeamId,
    welcomeQuickChatAgent,
    setWelcomeSessionStarting,
    messageListRef,
  });

  const handleStartLocalAgentSession = React.useCallback(async () => {
    if (welcomeSessionStarting || quickChatState.kind !== 'ready') return;
    setWelcomeSessionStarting(true);
    try {
      const result = await createQuickSession(quickChatState.target);
      if (!result.ok) {
        showQuickSessionFailure(result.reason);
      }
    } catch (e) {
      console.error('[ChatPanel] local agent welcome start failed', e);
      showQuickSessionFailure('server_error');
    } finally {
      setWelcomeSessionStarting(false);
    }
  }, [quickChatState, showQuickSessionFailure, welcomeSessionStarting]);

  // `createSessionAndSendFirst` is re-created every render and closes over
  // volatile values (sheetTeamId, selectedModelKey, resolved actor). The
  // memoized quick-action callback below must not capture a stale copy, so we
  // reach the latest version through a ref that is refreshed each render.
  const createSessionAndSendFirstRef = React.useRef(createSessionAndSendFirst);
  createSessionAndSendFirstRef.current = createSessionAndSendFirst;

  const handleLocalAgentQuickAction = React.useCallback(async (messageText: string) => {
    if (welcomeSessionStarting || !welcomeQuickChatAgent) return;
    setWelcomeSessionStarting(true);
    try {
      await createSessionAndSendFirstRef.current(
        { text: messageText, mentions: [] },
        {
          agents: [{ id: welcomeQuickChatAgent.id, displayName: welcomeQuickChatAgent.displayName }],
          members: [],
        },
      );
    } finally {
      setWelcomeSessionStarting(false);
    }
  }, [welcomeQuickChatAgent, welcomeSessionStarting]);

  const handleOpenAgentSettings = React.useCallback(() => {
    useUIStore.getState().openSettings('daemonGeneral');
  }, []);

  // ── Empty state ───────────────────────────────────────────────────────
  const handleCloseArchivedSession = React.useCallback(() => {
    closeArchivedSession();
  }, [closeArchivedSession]);

  const handleRestoreArchivedSession = React.useCallback(async () => {
    if (!viewingArchivedSessionId || isRestoringArchivedRef.current) return;
    isRestoringArchivedRef.current = true;
    setIsRestoringArchived(true);
    try {
      await restoreSession(viewingArchivedSessionId);
    } finally {
      isRestoringArchivedRef.current = false;
      setIsRestoringArchived(false);
    }
  }, [restoreSession, viewingArchivedSessionId]);

  const emptyState = React.useMemo(
    () =>
      renderChatEmptyState({
        activeSessionId,
        compact,
        t,
        draftPreselectedActor,
        welcomeQuickChatAgent,
        welcomeQuickChatLoading,
        welcomeSessionStarting,
        handleStartLocalAgentSession,
        handleLocalAgentQuickAction,
        handleOpenAgentSettings,
      }),
    [compact, t, draftPreselectedActor, welcomeQuickChatAgent, welcomeQuickChatLoading, welcomeSessionStarting, handleStartLocalAgentSession, handleLocalAgentQuickAction, handleOpenAgentSettings, activeSessionId],
  );

  const visibleSessionError =
    sessionError?.sessionId && sessionError.sessionId === displaySessionId
      ? sessionError
      : null;
  const visibleError =
    error && errorSessionId && errorSessionId === displaySessionId
      ? error
      : null;

  // Live streams render in Composer Live Dock. Keep displayV2Streams for
  // timeline diagnostics only (inactive/archived still live in the store).
  const v2DisplayRevision = useV2StreamingStore((s) =>
    displaySessionId ? (s.revisionBySession[displaySessionId] ?? 0) : 0,
  );
  const displayV2Streams = React.useMemo(() => {
    if (!displaySessionId) return [];
    const s = useV2StreamingStore.getState();
    const current = Object.values(s.byKey).filter(
      (e) => e.sessionId === displaySessionId,
    );
    const archived = s.archived.filter((e) => e.sessionId === displaySessionId);
    return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
    // v2DisplayRevision is the change signal; byKey/archived are read via
    // getState() to avoid re-subscribing to the whole store (perf). Do not add
    // byKey/archived to deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2DisplayRevision, displaySessionId]);

  const lastTimelineDiagSigRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!displaySessionId) return;
    const timelineMessages = displayMessages ?? [];
    const sig = JSON.stringify({
      messageListCount: timelineMessages.length,
      messageTailIds: timelineMessages.slice(-5).map((message) => message.id),
      bottomStreamCount: displayV2Streams.length,
      bottomStreamIds: displayV2Streams.map((entry) => entry.streamId),
    });
    if (sig === lastTimelineDiagSigRef.current) return;
    lastTimelineDiagSigRef.current = sig;
    logInterruptMsgDiag("ui.timeline", {
      sessionId: displaySessionId,
      messageListCount: timelineMessages.length,
      messageListTail: timelineMessages.slice(-5).map((message) => ({
        id: message.id,
        role: message.role,
        contentLength: (message.content ?? "").trim().length,
        toolCount: message.toolCalls?.length ?? 0,
        partTypes: message.parts?.map((part) => part.type) ?? [],
        timestamp: message.timestamp?.toISOString?.() ?? null,
      })),
      bottomStreamCount: displayV2Streams.length,
      bottomStreams: displayV2Streams.map((entry) => ({
        source: "archiveId" in entry ? "archived" : "byKey",
        archiveId: "archiveId" in entry ? entry.archiveId : null,
        streamId: entry.streamId,
        active: entry.active,
        toolCount: entry.toolCalls.length,
        partTypes: entry.parts.map((part) => part.type),
        lastUpdate: entry.lastUpdate,
      })),
    });
    if (isChromeExtension()) {
      const assistantTail = timelineMessages
        .filter((m) => m.role !== "user" && m.role !== "system")
        .slice(-6);
      logExtMsgDiag("ui.timeline", {
        sessionId: displaySessionId,
        assistantTail: assistantTail.map((m) => ({
          id: m.id,
          role: m.role,
          turnId: m.turnId ?? "",
          replyTo: m.replyToMessageId ?? "",
          contentLen: (m.content ?? "").trim().length,
          isInterrupt: m.id.startsWith("interrupt-"),
          toolCount: m.toolCalls?.length ?? 0,
          partTypes: m.parts?.map((p) => p.type) ?? [],
          hasProcessParts: (m.parts ?? []).some(
            (p) => p.type === "reasoning" || p.type === "tool-call",
          ),
        })),
        interruptVisible: assistantTail.filter((m) =>
          m.id.startsWith("interrupt-"),
        ).length,
        replyToHeaders: assistantTail.filter((m) =>
          Boolean(m.replyToMessageId?.trim()),
        ).length,
      });
    }
  }, [displaySessionId, displayMessages, displayV2Streams]);

  const hasSessionNotices = useSessionNoticeStore((s) =>
    displaySessionId ? (s.bySession[displaySessionId]?.length ?? 0) > 0 : false,
  );
  const messageBottomContent =
    visibleSessionError || visibleError || hasSessionNotices ? (
    <>
      {hasSessionNotices ? <SessionNoticeList sessionId={displaySessionId} /> : null}
      {visibleSessionError ? (
        <SessionErrorAlert
          error={visibleSessionError}
          onDismiss={clearSessionError}
        />
      ) : visibleError ? (
        <SessionErrorAlert
          error={visibleError}
          onDismiss={() => setError(null)}
        />
      ) : null}
    </>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────

  const threadParentSessionId = useThreadPanelStore((s) => s.parentSessionId);
  const threadListParentSessionId = useThreadListPanelStore((s) => s.parentSessionId);

  React.useEffect(() => {
    if (!displaySessionId) return;
    const listState = useThreadListPanelStore.getState();
    if (listState.isOpen && listState.parentSessionId !== displaySessionId) {
      listState.close();
    }
    const threadState = useThreadPanelStore.getState();
    if (threadState.isOpen && threadState.parentSessionId !== displaySessionId) {
      threadState.close();
    }
  }, [displaySessionId]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-row overflow-hidden",
        compact ? "h-full w-full relative" : "absolute inset-0",
      )}
    >
    <div
      className={cn(
      "relative flex min-h-0 min-w-0 flex-1 flex-col",
      )}
    >
      {/* Actors panel mounts in RightPanel for the 'actors' tab; trigger
       *  lives in App.tsx header alongside Knowledge / Changes. */}

      {/* Inactivity warning - task still running but no events */}
      {inactivityWarning && isStreaming && isConnected && (
        <div className="absolute top-2 right-12 z-20 flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("chat.taskRunning", "Task running...")}
        </div>
      )}

      {/* ─── Archived session read-only bar ─── */}
      {isViewingArchived && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <button
            type="button"
            onClick={handleCloseArchivedSession}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t("chat.backToActiveSession", "Back to active session")}</span>
          </button>
          <div className="min-w-0 flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <Archive size={12} />
            <span className="truncate">
              {archivedSession?.title || t("chat.archivedSession", "Archived session")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={isRestoringArchived}
            onClick={() => void handleRestoreArchivedSession()}
          >
            <RefreshCw className={cn("h-3 w-3", isRestoringArchived && "animate-spin")} />
            {t("chat.restoreSession", "Restore")}
          </Button>
        </div>
      )}

      {workspaceBootstrapped && !workspaceReady && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 px-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div>
              <p className="text-base font-medium">
                {t("chat.startingAgent", "Starting agent...")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("chat.waitingForAgent", "Sessions are ready. Waiting for agent runtime to finish starting.")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Message List (fade on session switch; input stays stable) ─── */}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col overflow-hidden",
          "transition-opacity duration-150 ease-in-out motion-reduce:transition-none",
        )}
        style={{ opacity: isViewingArchived ? 1 : sessionFadeOpacity }}
      >
        {!isViewingArchived ? (
          <AcpStreamDebugPanel sessionId={displaySessionId} />
        ) : null}
        {isViewingArchived ? (
          <MessageList
            ref={messageListRef}
            messages={archivedSessionMessages}
            activeSessionId={viewingArchivedSessionId}
            isStreaming={false}
            streamingMessageId={null}
            compact={compact}
            sessionDirectory={archivedSession?.directory}
          />
        ) : (
          <MessageList
            ref={messageListRef}
            messages={displayMessages ?? []}
            activeSessionId={displaySessionId}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            compact={compact}
            emptyState={emptyState}
            bottomContent={messageBottomContent}
          />
        )}
      </div>

      {/* ─── Input Area (with Permission & Error UI above it) ─────────── */}
      {isViewingArchived ? (
        <div className="border-t border-border bg-background px-3 py-3">
          {archivedSessionError && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  {t("chat.archivedSessionLoadError", "Could not load archived session")}
                </div>
                <div className="break-words text-xs text-destructive/80">
                  {archivedSessionError}
                </div>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("chat.restoreArchivedHint", "Restore this session to continue chatting")}
          </div>
        </div>
      ) : (
        activeSessionId || draftPreselectedActor ? (
          <ChatInputArea
            activeSessionId={activeSessionId}
            compact={compact}
            pendingFiles={pendingFiles}
            onAppendPendingFiles={appendPendingFiles}
            onRemovePendingFile={removePendingFile}
            engagedAgents={engagedAgents}
            engagedUiEntries={engagedUiEntries}
            agentToRuntimeId={agentToRuntimeId}
            agentToBackendType={agentToBackendType}
            localDaemonAgent={localDaemonAgent}
            onSwitchToLocalAgent={handleSwitchToLocalAgent}
            onRetryOfflineAgents={handleRetryOfflineAgents}
            onEngageAgent={(a) => {
              if (!activeSessionId) {
                return;
              }
              addAgentForSession(a);
              if (!sheetTeamId) return;
              void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
                void ensureAgentRuntimesForSession({
                  sessionId: activeSessionId,
                  teamId: sheetTeamId,
                  agentActorIds: [a.id],
                  reason: "mention_pill",
                });
              });
            }}
            onRemoveAgent={removeAgentForSession}
            agentMentionLocked={isSoloAgentSessionActive}
            sessionModelId={activeSessionModelId}
            activeStreamingAgents={activeStreamingAgents}
            onInterruptAgent={handleInterruptAgent}
            onSubmit={handleSubmit}
            isStreaming={isStreaming}
            messageQueue={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            onHeightChange={handleInputHeightChange}
            onComposerFocus={handleComposerFocus}
            bottomOffsetPx={terminalBottomOffset}
            stackTodos={hasComposerPlanData ? (combinedTodos as Todo[]) : []}
            stackQueue={hasComposerPlanData ? messageQueue : []}
            planSlotHidden={hasComposerPlanData && !showInlineTodo}
            pendingQuestion={activeInputQuestion}
          />
        ) : null
      )}

      {terminalOpen && workspacePath && (
        <React.Suspense fallback={null}>
          <TerminalPanel
            workspaceId={workspacePath}
            workspacePath={workspacePath}
            allowedRoots={[workspacePath]}
          />
        </React.Suspense>
      )}
    </div>
    {displaySessionId && threadListParentSessionId === displaySessionId ? (
      <ThreadListPanel parentSessionId={displaySessionId} />
    ) : null}
    {displaySessionId && threadParentSessionId === displaySessionId ? (
      <ThreadPanel parentSessionId={displaySessionId} />
    ) : null}
    </div>
  );
}
