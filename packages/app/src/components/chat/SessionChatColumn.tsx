import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { adaptTeamcluMessages } from "@/lib/v2-message-adapter";
import { MessageList, type MessageListHandle } from "./MessageList";
import { ChatInputArea } from "./ChatInputArea";
import { SessionErrorAlert } from "./SessionErrorAlert";
import { SessionNoticeList } from "./SessionNoticeList";
import { useChatSend } from "./use-chat-send";
import { useSessionStore } from "@/stores/session";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useStreamingStore } from "@/stores/streaming";
import {
  isStreamInterruptible,
  useV2StreamingStore,
  selectPersistedPlanForSession,
  type StreamingPlanEntry,
} from "@/stores/v2-streaming-store";
import { useEngagedAgentRuntimeMap } from "@/hooks/use-engaged-agent-runtime-map";
import { useEngagedAgentUiStates } from "@/hooks/use-engaged-agent-ui-states";
import { useEnsureEngagedRuntimesOnSessionFocus } from "@/hooks/use-ensure-engaged-runtimes-on-session-focus";
import { useReensureRuntimesOnMqttReconnect } from "@/hooks/use-reensure-runtimes-on-mqtt-reconnect";
import { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import { ensureParticipantModels } from "@/stores/participant-model-store";
import { isSoloAgentSession } from "@/lib/session-empty-thread-starters";
import { isAgentActorType } from "@/lib/actor-type";
import { getBackend } from "@/lib/backend";
import { resolveSessionEstablishedModel } from "@/lib/session-established-model";
import {
  selectAgentModel,
  resolveRuntimeStateEntryForAgent,
  backendTypeFromRuntimeEntry,
} from "@/lib/runtime-state-resolve";
import {
  resolveAgentCatalogModels,
  localRecentModelFallback,
} from "@/lib/agent-model-fallback";
import { useLocalDaemonActorId } from "@/lib/daemon-agent-admin";
import { useLocalDaemonCatalogStore } from "@/stores/local-daemon-catalog-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";
import { clientMruModels } from "@/stores/client-model-mru";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  quickChatLocalDaemonAgent,
  useQuickChatReadiness,
} from "@/hooks/use-quick-chat-readiness";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { hasVisiblePendingPermissions } from "./PermissionCard";
import { collectAcpStreamingPermissions } from "@/lib/teamclu/acp-permission-entries";
import { useSessionPermissionMode } from "@/lib/session-permission-mode";
import { interruptAgentActor } from "@/lib/teamclu/interrupt-agent";
import { toast } from "sonner";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { Todo } from "@/stores/session-types";
import type { Message as ProtoMessage } from "@/lib/proto/teamclu_pb";

const EMPTY_AGENTS: AttachedAgent[] = [];
const EMPTY_PROTO_MESSAGES: ProtoMessage[] = [];

export type SessionChatColumnProps = {
  /** Persisted session for messages / MQTT (null before lazy thread create). */
  sessionId: string | null;
  /** Key for composer-scoped state (engaged agent, model pick). Always set. */
  composerSessionId: string;
  /** Participant roster for @-mentions (defaults to composerSessionId). */
  mentionSessionId?: string | null;
  /** Lazy-create path (thread draft) — must return a persisted session id. */
  ensureSessionBeforeSend?: () => Promise<string>;
  compact?: boolean;
  inputLayout?: "overlay" | "inline";
  /** Isolated draft so dual composers (main + thread) do not clobber each other. */
  isolateComposerDraft?: boolean;
  /** Suppress nested "+ Open thread" affordances (thread panel). */
  suppressThreadBadge?: boolean;
  /** Parent session when this column is a thread panel. */
  parentSessionId?: string | null;
  className?: string;
};

export function SessionChatColumn({
  sessionId,
  composerSessionId,
  mentionSessionId: mentionSessionIdProp,
  ensureSessionBeforeSend,
  compact = true,
  inputLayout = "overlay",
  isolateComposerDraft = false,
  suppressThreadBadge = false,
  parentSessionId = null,
  className,
}: SessionChatColumnProps) {
  const { t } = useTranslation();
  const mentionSessionId = mentionSessionIdProp ?? composerSessionId;
  const messageListRef = React.useRef<MessageListHandle>(null);
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  const [composerDraft, setComposerDraft] = React.useState("");
  const noop = React.useCallback(() => {}, []);
  const noopSetBool = React.useCallback((_value: React.SetStateAction<boolean>) => {}, []);

  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants);
  const sessionPermissionMode = useSessionPermissionMode(sessionId);
  const messageQueue = useSessionStore((s) => s.messageQueue);
  const removeFromQueue = useSessionStore.getState().removeFromQueue;
  const clearSessionError = useSessionStore.getState().clearSessionError;
  const streamingMessageId = useStreamingStore((s) => s.streamingMessageId);
  const todos = useSessionStore((s) => s.todos);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const sessionError = useSessionStore((s) => s.sessionError);
  const error = useSessionStore((s) => s.error);
  const errorSessionId = useSessionStore((s) => s.errorSessionId);
  const setError = useSessionStore.getState().setError;

  const v2SessionRevision = useV2StreamingStore((s) =>
    sessionId ? (s.revisionBySession[sessionId] ?? 0) : 0,
  );
  const persistedSessionPlan = useV2StreamingStore((s) =>
    selectPersistedPlanForSession(s, sessionId),
  );
  const v2Streams = React.useMemo(() => {
    if (!sessionId) return [];
    const s = useV2StreamingStore.getState();
    const current = Object.values(s.byKey).filter((e) => e.sessionId === sessionId);
    const archived = s.archived.filter((e) => e.sessionId === sessionId);
    return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2SessionRevision, sessionId]);

  const planTodos = React.useMemo((): Todo[] => {
    const mapPlan = (entries: StreamingPlanEntry[], actorId: string): Todo[] =>
      entries.map((e, i) => ({
        id: `plan:${actorId}:${i}`,
        status: e.status,
        content: e.content,
        priority: e.priority,
      }));
    const latestWithPlan = [...v2Streams].reverse().find((e) => e.planEntries.length > 0);
    if (latestWithPlan) return mapPlan(latestWithPlan.planEntries, latestWithPlan.actorId);
    if (persistedSessionPlan?.planEntries.length) {
      return mapPlan(persistedSessionPlan.planEntries, persistedSessionPlan.actorId);
    }
    return [];
  }, [v2Streams, persistedSessionPlan]);

  const acpPendingForTodo = React.useMemo(
    () => collectAcpStreamingPermissions(sessionId, useV2StreamingStore.getState().byKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, v2SessionRevision],
  );

  const showInlineTodo = React.useMemo(() => {
    if (!sessionId) return false;
    if (todos.length === 0 && messageQueue.length === 0 && planTodos.length === 0) return false;
    return !hasVisiblePendingPermissions(
      sessionId,
      useSessionStore.getState().sessions,
      pendingPermissions,
      acpPendingForTodo,
      sessionPermissionMode,
    );
  }, [
    sessionId,
    acpPendingForTodo,
    messageQueue.length,
    pendingPermissions,
    sessionPermissionMode,
    todos,
    planTodos.length,
  ]);

  const combinedTodos = React.useMemo(
    () => (planTodos.length > 0 ? [...planTodos, ...todos] : todos),
    [planTodos, todos],
  );
  const hasComposerPlanData =
    Boolean(sessionId) && (combinedTodos.length > 0 || messageQueue.length > 0);

  const sessionEngagedAgents = useEngagedAgentStore((s) =>
    s.bySession[composerSessionId] ?? EMPTY_AGENTS,
  );
  const engagedAgents = sessionEngagedAgents;
  const engagedAgentIds = React.useMemo(() => engagedAgents.map((a) => a.id), [engagedAgents]);

  const activeStreamingAgentIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const entry of v2Streams) {
      if (isStreamInterruptible(entry)) ids.add(entry.actorId);
    }
    return ids;
  }, [v2Streams]);

  const { agentToRuntimeId, agentToBackendType } = useEngagedAgentRuntimeMap(
    composerSessionId,
    engagedAgentIds,
  );
  const agentUiContext = React.useMemo(
    () => ({ kind: "session", sessionId: composerSessionId } as const),
    [composerSessionId],
  );
  const engagedUiEntries = useEngagedAgentUiStates(
    engagedAgents,
    agentToRuntimeId,
    activeStreamingAgentIds,
    agentUiContext,
  );

  const sessionParticipants = useSessionParticipantStore((s) =>
    mentionSessionId ? s.participantsBySession[mentionSessionId] : undefined,
  );
  const participantsLoading = useSessionParticipantStore((s) =>
    mentionSessionId ? s.loadingBySession[mentionSessionId] ?? false : false,
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

  const sessionRow = useSessionListStore((s) =>
    sessionId ? s.rows.find((r) => r.id === sessionId) : undefined,
  );
  const parentSessionRow = useSessionListStore((s) =>
    parentSessionId ? s.rows.find((r) => r.id === parentSessionId) : undefined,
  );
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);
  const fallbackTeamId = useSessionListStore((s) => s.rows[0]?.team_id ?? null);
  // Thread sessions are excluded from the list — inherit team from parent row.
  const sheetTeamId =
    sessionRow?.team_id ??
    parentSessionRow?.team_id ??
    fallbackTeamId ??
    currentTeamId;

  React.useEffect(() => {
    if (!mentionSessionId) return;
    void ensureParticipants([mentionSessionId]);
  }, [mentionSessionId, ensureParticipants]);

  React.useEffect(() => {
    if (!sessionId) return;
    ensureParticipantModels(sessionId);
    if (!sheetTeamId) return;
    void ensureSessionLiveSubscribed(sheetTeamId, sessionId);
  }, [sessionId, sheetTeamId]);

  useEnsureEngagedRuntimesOnSessionFocus({
    sessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });
  useReensureRuntimesOnMqttReconnect({
    sessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });

  const addAgentForSession = React.useCallback(
    (agent: AttachedAgent) => {
      useEngagedAgentStore.getState().addAgent(composerSessionId, agent);
    },
    [composerSessionId],
  );
  const removeAgentForSession = React.useCallback(
    (agentId: string) => {
      if (isSoloAgentSessionActive) return;
      useEngagedAgentStore.getState().removeAgent(composerSessionId, agentId);
    },
    [composerSessionId, isSoloAgentSessionActive],
  );

  const handleRetryOfflineAgents = React.useCallback(() => {
    if (!sessionId || !sheetTeamId) return;
    const offlineIds = engagedUiEntries
      .filter((e) => e.uiState === "offline" || e.uiState === "runtime-error")
      .map((e) => e.agent.id);
    if (offlineIds.length === 0) return;
    void import("@/lib/teamclu/runtime-ensure-scheduler").then(({ resetRuntimeEnsureThrottle }) => {
      resetRuntimeEnsureThrottle();
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId,
          teamId: sheetTeamId,
          agentActorIds: offlineIds,
          reason: "offline_banner_retry",
        });
      });
    });
  }, [sessionId, sheetTeamId, engagedUiEntries]);

  const handleSwitchToLocalAgent = React.useCallback(
    (local: AttachedAgent) => {
      for (const entry of engagedUiEntries) {
        if (
          entry.uiState === "offline" ||
          entry.uiState === "stale" ||
          entry.uiState === "connecting" ||
          entry.uiState === "runtime-error"
        ) {
          useAgentModelPickStore.getState().clearPick(composerSessionId, entry.agent.id);
          removeAgentForSession(entry.agent.id);
        }
      }
      addAgentForSession(local);
      if (!sheetTeamId || !sessionId) return;
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId,
          teamId: sheetTeamId,
          agentActorIds: [local.id],
          reason: "switch_to_local_agent",
        });
      });
    },
    [sessionId, composerSessionId, engagedUiEntries, removeAgentForSession, addAgentForSession, sheetTeamId],
  );

  React.useEffect(() => {
    if (engagedAgents.length > 0) return;
    const rosterSessionId = mentionSessionId;
    if (!rosterSessionId) return;

    const ensureRuntime = (agentActorId: string) => {
      if (!sheetTeamId || !sessionId) return;
      const established =
        resolveSessionEstablishedModel(
          useSessionMessageStore.getState().messages[sessionId],
          agentActorId,
        )?.trim() || undefined;
      void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId,
          teamId: sheetTeamId,
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
      useEngagedAgentStore.getState().setAgents(composerSessionId, [{
        id: sole.actorId,
        displayName: sole.displayName || "AI",
        auto: true,
      }]);
      ensureRuntime(sole.actorId);
      return true;
    };

    if (sessionParticipants !== undefined && sessionParticipants.length > 0) {
      engageFromRoster(sessionParticipants);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const actors = await getBackend().sessionMembers.listParticipants(rosterSessionId);
        if (cancelled) return;
        engageFromRoster(
          actors.map((row) => ({
            isAgent: isAgentActorType(row.actor_type),
            isExternal: row.actor_type === "external",
            actorId: row.id,
            displayName: row.display_name?.trim() || "AI",
          })),
        );
      } catch {
        /* roster optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composerSessionId, mentionSessionId, sessionId, engagedAgents.length, sessionParticipants, sheetTeamId]);

  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const localDaemonActorId = useLocalDaemonActorId();
  const localDaemonCatalog = useLocalDaemonCatalogStore((s) => {
    const path = workspacePath?.trim();
    return path ? s.byWorkspacePath[path] : undefined;
  });
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId);
  const modelAgentId = engagedAgentIds[0] ?? "";
  const modelPickScopeId = composerSessionId;
  const activeEstablishedModel = useSessionMessageStore((s) =>
    sessionId && modelAgentId
      ? resolveSessionEstablishedModel(s.messages[sessionId], modelAgentId)
      : null,
  );
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
      sessionId,
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
    sessionId,
  ]);

  const quickChatState = useQuickChatReadiness();
  const localDaemonAgent = React.useMemo(
    () => quickChatLocalDaemonAgent(quickChatState),
    [quickChatState],
  );

  const messagesRaw = useSessionMessageStore((s) =>
    sessionId ? s.messages[sessionId] ?? EMPTY_PROTO_MESSAGES : EMPTY_PROTO_MESSAGES,
  );
  const displayMessages = React.useMemo(
    () => adaptTeamcluMessages(messagesRaw, { deferProcess: true }) ?? [],
    [messagesRaw],
  );

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
      agents.push({
        actorId: entry.actorId,
        displayName: engagedAgents.find((agent) => agent.id === entry.actorId)?.displayName,
        entry,
      });
    }
    return agents;
  }, [v2Streams, engagedAgents]);

  const v2HasActiveStream = useV2StreamingStore((s) =>
    sessionId
      ? Object.values(s.byKey).some((e) => e.sessionId === sessionId && e.active)
      : false,
  );
  const isStreaming =
    activeStreamingAgents.length > 0 ||
    v2HasActiveStream ||
    Boolean(streamingMessageId && sessionId && displayMessages.some((m) => m.id === streamingMessageId));

  const handleInterruptAgent = React.useCallback(
    (agentActorId: string) => {
      if (!sessionId) return;
      void interruptAgentActor({ sessionId, agentActorId }).catch((err) => {
        toast.error(t("chat.interruptFailed", "无法打断 agent 回复"), {
          description: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [sessionId, t],
  );

  const { sendIntoSession } = useChatSend({
    t,
    activeSessionId: composerSessionId,
    displaySessionId: sessionId,
    setDisplaySessionId: noop,
    setSessionFadeOpacity: noop,
    draftPreselectedActor: null,
    clearSessionError,
    pendingFiles,
    setPendingFiles,
    engagedAgents,
    engagedUiEntries,
    sheetTeamId,
    welcomeQuickChatAgent: null,
    setWelcomeSessionStarting: noopSetBool,
    messageListRef,
    clearGlobalDraft: !isolateComposerDraft,
  });

  const handleSubmit = React.useCallback(
    async (message: PromptInputMessage) => {
      let sid = sessionId;
      if (!sid) {
        if (!ensureSessionBeforeSend) return;
        sid = await ensureSessionBeforeSend();
      }
      await sendIntoSession(sid, message);
      if (isolateComposerDraft) setComposerDraft("");
    },
    [sessionId, ensureSessionBeforeSend, sendIntoSession, isolateComposerDraft],
  );

  const handleInputHeightChange = React.useCallback((height: number) => {
    if (inputLayout === "inline") return;
    messageListRef.current?.handleInputHeightChange(height);
  }, [inputLayout]);

  const handleComposerFocus = React.useCallback(() => {
    messageListRef.current?.pauseAutoFollowIfReading();
  }, []);

  const appendPendingFiles = React.useCallback((files: File[]) => {
    setPendingFiles((prev) => [...prev, ...files]);
  }, []);
  const removePendingFile = React.useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const visibleSessionError =
    sessionError?.sessionId && sessionError.sessionId === sessionId ? sessionError : null;
  const visibleError =
    error && errorSessionId && errorSessionId === sessionId ? error : null;
  const hasSessionNotices = useSessionNoticeStore((s) =>
    sessionId ? (s.bySession[sessionId]?.length ?? 0) > 0 : false,
  );
  const messageBottomContent =
    visibleSessionError || visibleError || hasSessionNotices ? (
      <>
        {hasSessionNotices && sessionId ? <SessionNoticeList sessionId={sessionId} /> : null}
        {visibleSessionError ? (
          <SessionErrorAlert error={visibleSessionError} onDismiss={clearSessionError} />
        ) : visibleError ? (
          <SessionErrorAlert error={visibleError} onDismiss={() => setError(null)} />
        ) : null}
      </>
    ) : null;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <MessageList
          ref={messageListRef}
          messages={displayMessages}
          activeSessionId={sessionId}
          isStreaming={isStreaming}
          streamingMessageId={
            sessionId && streamingMessageId && displayMessages.some((m) => m.id === streamingMessageId)
              ? streamingMessageId
              : null
          }
          compact={compact}
          externalComposer={inputLayout === "inline"}
          emptyState={suppressThreadBadge ? null : undefined}
          bottomContent={messageBottomContent}
          suppressThreadBadge={suppressThreadBadge}
        />
      </div>

      <ChatInputArea
        activeSessionId={composerSessionId}
        permissionSessionId={sessionId}
        mentionSessionId={mentionSessionId}
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
        onEngageAgent={addAgentForSession}
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
        stackTodos={hasComposerPlanData ? combinedTodos : []}
        stackQueue={hasComposerPlanData ? messageQueue : []}
        planSlotHidden={hasComposerPlanData && !showInlineTodo}
        draftOverride={
          isolateComposerDraft
            ? { value: composerDraft, onChange: setComposerDraft }
            : undefined
        }
        inputLayout={inputLayout}
      />
    </div>
  );
}
