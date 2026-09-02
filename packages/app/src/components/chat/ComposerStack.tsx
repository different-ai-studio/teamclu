import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Maximize2, Minimize2, Square } from "lucide-react";
import { actorAvatarColor } from "@/lib/actor-color";
import { resolveApprovalAnchorActorId } from "@/lib/permission-actor";
import { useActorDisplayName } from "@/hooks/useActorDisplayName";
import { cn } from "@/lib/utils";
import type { Todo } from "@/stores/session-types";
import type { QueuedMessage } from "@/stores/session";
import {
  useV2StreamingStore,
  type AgentStreamEntry,
} from "@/stores/v2-streaming-store";
import { PermissionApprovalPanel } from "./PermissionApprovalPanel";
import { PermissionWaitingBanner } from "./PermissionWaitingBanner";
import { ComposerPlanSlot } from "./ComposerPlanSlot";
import { QuestionInputDock } from "./QuestionInputDock";
import { StreamingAgentBubble } from "./StreamingAgentBubble";
import type { PendingQuestionState } from "@/stores/session-types";
import {
  composerGlassChildClass,
  composerGlassFillClass,
  composerGlassSurfaceClass,
  composerStackFormSlotClass,
  composerStackRowDividerClass,
  composerStackShellClass,
} from "./composer-glass";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { usePendingPermissionsQueue } from "./use-pending-permissions-queue";

export type ActiveStreamingAgent = {
  actorId: string;
  displayName?: string;
  /** Live stream entry for expandable dock panel. */
  entry?: AgentStreamEntry;
};

const LIVE_INLINE_SCROLL_CLASS =
  "max-h-[220px] overflow-y-auto border-t border-border/50 bg-gradient-to-b from-[#fbf9f4] to-white px-3 py-2.5 dark:from-background dark:to-paper";

const LIVE_FLOAT_SCROLL_CLASS =
  "min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-[#fbf9f4] to-white px-3 py-2.5 dark:from-background dark:to-paper";

function agentEntryHasToolCall(
  entry: AgentStreamEntry | undefined,
  toolCallId: string,
): boolean {
  if (!entry || !toolCallId) return false;
  if (entry.toolCalls.some((toolCall) => toolCall.id === toolCallId)) return true;
  return entry.parts.some(
    (part) =>
      part.type === "tool-call" &&
      (part.toolCallId === toolCallId || part.toolCall?.id === toolCallId),
  );
}

function resolveQuestionAgentId(
  pendingQuestion: PendingQuestionState,
  agents: ReadonlyArray<ActiveStreamingAgent>,
): string | null {
  const { agentActorId, toolCallId } = pendingQuestion;
  if (toolCallId) {
    const byToolCall = agents.find((agent) =>
      agentEntryHasToolCall(agent.entry, toolCallId),
    );
    if (byToolCall) return byToolCall.actorId;
  }
  if (
    agentActorId &&
    agents.some((agent) => agent.actorId === agentActorId)
  ) {
    return agentActorId;
  }
  return null;
}

function useLiveScrollFollow(active: boolean, entry: AgentStreamEntry | undefined) {
  const liveScrollRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);

  const scrollLiveToBottom = React.useCallback(() => {
    const el = liveScrollRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - targetTop) < 2) return;
    el.scrollTop = targetTop;
  }, []);

  React.useEffect(() => {
    if (!active || !entry?.active) {
      stickToBottomRef.current = true;
    }
  }, [active, entry?.active, entry?.actorId]);

  React.useEffect(() => {
    if (!active || !entry || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => scrollLiveToBottom());
    return () => cancelAnimationFrame(frame);
  }, [
    active,
    entry?.lastUpdate,
    entry?.parts.length,
    entry?.outputText.length,
    entry?.thinkingText.length,
    entry?.toolCalls.length,
    scrollLiveToBottom,
  ]);

  const handleLiveScroll = React.useCallback(() => {
    const el = liveScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  }, []);

  return { liveScrollRef, handleLiveScroll };
}

function ComposerAgentStrip({
  actorId,
  displayNameHint,
  waitingForApproval,
  waitingForQuestion = false,
  showInterrupt,
  onInterrupt,
  roundsTop = false,
  embeddedInGlass = false,
  expanded,
  enlarged,
  onToggleExpand,
  onToggleEnlarge,
  entry,
  suppressQuestionToolCallId,
}: {
  actorId: string;
  displayNameHint?: string;
  waitingForApproval: boolean;
  waitingForQuestion?: boolean;
  showInterrupt: boolean;
  onInterrupt: (agentId: string) => void;
  roundsTop?: boolean;
  embeddedInGlass?: boolean;
  expanded: boolean;
  enlarged: boolean;
  onToggleExpand: () => void;
  onToggleEnlarge: () => void;
  entry?: AgentStreamEntry;
  suppressQuestionToolCallId?: string;
}) {
  const { t } = useTranslation();
  const resolvedName = useActorDisplayName(actorId);
  const displayName = displayNameHint || resolvedName || actorId.slice(0, 8);
  const colors = actorAvatarColor(actorId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";
  const canExpand = Boolean(entry);
  const showInlinePanel = expanded && canExpand && !enlarged;
  const { liveScrollRef, handleLiveScroll } = useLiveScrollFollow(showInlinePanel, entry);
  const indicatorToolCallIds = React.useMemo(
    () =>
      suppressQuestionToolCallId
        ? new Set([suppressQuestionToolCallId])
        : undefined,
    [suppressQuestionToolCallId],
  );
  const interrupting = useV2StreamingStore((s) =>
    entry?.sessionId
      ? s.isInterruptedFlushPending(entry.sessionId, actorId)
      : false,
  );

  const expandClasses = cn(
    "grid transition-[grid-template-rows] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
    showInlinePanel ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
  );

  const statusLabel = waitingForApproval ? (
    t("chat.streamingBar.waitingApproval", "Waiting for your approval…")
  ) : waitingForQuestion ? (
    <>
      {t("chat.streamingBar.waitingQuestion", "等待你的回答")}
      <span
        className="ml-1.5 inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-coral align-middle"
        aria-hidden
      />
    </>
  ) : interrupting ? (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      {t("chat.interrupt.stopping", "正在停止回复…")}
    </span>
  ) : (
    <>
      {t("chat.streamingBar.streamingActive", "正在回复")}
      <span
        className="ml-1.5 inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-coral align-middle"
        aria-hidden
      />
    </>
  );

  return (
    <div
      className={cn(
        "box-border w-full",
        embeddedInGlass ? composerGlassChildClass : composerGlassSurfaceClass,
        composerStackRowDividerClass,
        !embeddedInGlass && roundsTop && "overflow-hidden rounded-t-[14px]",
      )}
      data-testid="streaming-agent-row"
      data-actor-id={actorId}
      data-expanded={expanded && canExpand ? "true" : "false"}
      data-enlarged={enlarged ? "true" : "false"}
    >
      <div
        className={cn(
          "box-border flex min-h-9 w-full items-center gap-1 px-2 py-[7px] pr-3.5",
          enlarged && "bg-coral-soft/20",
        )}
      >
        {canExpand ? (
          <button
            type="button"
            data-testid="streaming-agent-strip"
            className="box-border flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left hover:bg-black/[0.02]"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("chat.streamingBar.collapse", "收起")
                : t("chat.streamingBar.expand", "展开")
            }
            onClick={onToggleExpand}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200",
                expanded && "rotate-180 text-coral",
              )}
              aria-hidden
            />
            <span
              className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ring-[1.5px] ring-coral"
              style={{ backgroundColor: colors.bg }}
              aria-hidden
            >
              {initial}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-foreground">
                {displayName}
              </span>
              <span
                className={cn(
                  "text-[11px] text-faint",
                  !waitingForApproval && "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            </div>
          </button>
        ) : (
          <div
            data-testid="streaming-agent-strip"
            className="box-border flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-1.5"
          >
            <span
              className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ring-[1.5px] ring-coral"
              style={{ backgroundColor: colors.bg }}
              aria-hidden
            >
              {initial}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-foreground">
                {displayName}
              </span>
              <span
                className={cn(
                  "text-[11px] text-faint",
                  !waitingForApproval && "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            </div>
          </div>
        )}
        {canExpand && expanded ? (
          <button
            type="button"
            data-testid="streaming-agent-enlarge"
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-faint transition-colors hover:bg-selected hover:text-foreground",
              enlarged && "text-coral hover:bg-coral/10 hover:text-coral",
            )}
            aria-label={
              enlarged
                ? t("chat.streamingBar.restore", "还原")
                : t("chat.streamingBar.enlarge", "放大")
            }
            aria-pressed={enlarged}
            onClick={onToggleEnlarge}
          >
            {enlarged ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
        {showInterrupt && interrupting ? (
          <button
            type="button"
            data-testid="streaming-agent-stopping"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-panel px-2.5 text-[11.5px] font-semibold text-ink-2"
            aria-busy="true"
            aria-label={t("chat.interrupt.stoppingShort", "停止中")}
            disabled
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {t("chat.interrupt.stoppingShort", "停止中")}
          </button>
        ) : showInterrupt ? (
          <button
            type="button"
            data-testid="streaming-agent-stop"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-coral/15 text-coral transition-colors hover:bg-coral/25"
            aria-label={t("chat.interruptAgent", "Interrupt {{name}}", {
              name: displayName,
            })}
            onClick={() => onInterrupt(actorId)}
          >
            <Square className="h-2.5 w-2.5 fill-current" />
          </button>
        ) : null}
      </div>

      <div
        className={expandClasses}
        data-testid="streaming-agent-live-panel"
        data-open={showInlinePanel ? "true" : "false"}
      >
        <div className="min-h-0 overflow-hidden">
          {entry && showInlinePanel ? (
            <div
              ref={liveScrollRef}
              onScroll={handleLiveScroll}
              data-testid="streaming-agent-live-scroll"
              className={LIVE_INLINE_SCROLL_CLASS}
            >
              <StreamingAgentBubble
                entry={entry}
                variant="dock"
                indicatorToolCallIds={indicatorToolCallIds}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LiveEnlargeFloat({
  agent,
  onRestore,
  onInterrupt,
  showInterrupt,
  suppressQuestionToolCallId,
}: {
  agent: ActiveStreamingAgent;
  onRestore: () => void;
  onInterrupt?: (agentId: string) => void;
  showInterrupt: boolean;
  suppressQuestionToolCallId?: string;
}) {
  const { t } = useTranslation();
  const entry = agent.entry!;
  const resolvedName = useActorDisplayName(agent.actorId);
  const displayName =
    agent.displayName || resolvedName || agent.actorId.slice(0, 8);
  const colors = actorAvatarColor(agent.actorId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";
  const { liveScrollRef, handleLiveScroll } = useLiveScrollFollow(true, entry);
  const indicatorToolCallIds = React.useMemo(
    () =>
      suppressQuestionToolCallId
        ? new Set([suppressQuestionToolCallId])
        : undefined,
    [suppressQuestionToolCallId],
  );
  const restoreRef = React.useRef<HTMLButtonElement>(null);
  const interrupting = useV2StreamingStore((s) =>
    s.isInterruptedFlushPending(entry.sessionId, agent.actorId),
  );

  React.useEffect(() => {
    restoreRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onRestore();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onRestore]);

  return (
    <div
      data-testid="streaming-agent-live-float"
      className="pointer-events-auto absolute inset-x-0 bottom-full z-30 mb-2 flex h-[min(620px,72vh)] max-h-[min(620px,72vh)] flex-col overflow-hidden rounded-[14px] border border-border bg-paper shadow-[0_22px_48px_-18px_rgba(20,20,15,0.28)]"
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.streamingBar.enlarge", "放大")}
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border/50 px-3.5 py-[9px]">
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 rotate-180 text-coral"
          aria-hidden
        />
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ring-[1.5px] ring-coral"
          style={{ backgroundColor: colors.bg }}
          aria-hidden
        >
          {initial}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">
            {displayName}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {interrupting ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {t("chat.interrupt.stopping", "正在停止回复…")}
              </span>
            ) : (
              <>
                {t("chat.streamingBar.streamingActive", "正在回复")}
                <span
                  className="ml-1.5 inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-coral align-middle"
                  aria-hidden
                />
              </>
            )}
          </span>
        </div>
        <button
          ref={restoreRef}
          type="button"
          data-testid="streaming-agent-float-restore"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-coral transition-colors hover:bg-coral/10"
          aria-label={t("chat.streamingBar.restore", "还原")}
          onClick={onRestore}
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </button>
        {showInterrupt && onInterrupt && interrupting ? (
          <button
            type="button"
            data-testid="streaming-agent-float-stopping"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-panel px-2.5 text-[11.5px] font-semibold text-ink-2"
            aria-busy="true"
            aria-label={t("chat.interrupt.stoppingShort", "停止中")}
            disabled
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {t("chat.interrupt.stoppingShort", "停止中")}
          </button>
        ) : showInterrupt && onInterrupt ? (
          <button
            type="button"
            data-testid="streaming-agent-float-stop"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-coral/15 text-coral transition-colors hover:bg-coral/25"
            aria-label={t("chat.interruptAgent", "Interrupt {{name}}", {
              name: displayName,
            })}
            onClick={() => onInterrupt(agent.actorId)}
          >
            <Square className="h-2.5 w-2.5 fill-current" />
          </button>
        ) : null}
      </div>
      <div
        ref={liveScrollRef}
        onScroll={handleLiveScroll}
        data-testid="streaming-agent-live-scroll"
        className={LIVE_FLOAT_SCROLL_CLASS}
      >
        <StreamingAgentBubble
          entry={entry}
          variant="dock"
          indicatorToolCallIds={indicatorToolCallIds}
        />
      </div>
    </div>
  );
}

export function ComposerStack({
  agents,
  onInterrupt,
  todos = [],
  queue = [],
  onRemoveFromQueue,
  planSlotHidden = false,
  permissionSessionId = null,
  pendingQuestion = null,
  children,
}: {
  agents: ReadonlyArray<ActiveStreamingAgent>;
  onInterrupt?: (agentId: string) => void;
  todos?: Todo[];
  queue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  /** Hide plan slot visually but keep state (e.g. while approval card is showing). */
  planSlotHidden?: boolean;
  /** Session whose pending ACP permissions render in this stack (defaults to main active). */
  permissionSessionId?: string | null;
  /** Pending agent question — renders in-stack above input and keeps live context visible. */
  pendingQuestion?: PendingQuestionState | null;
  children?: React.ReactNode;
}) {
  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId);
  const resolvedPermissionSessionId = permissionSessionId ?? activeSessionId;
  const {
    sessionPermissionMode,
    currentEntry,
    queuedCount,
    waitingRequesterActorId,
    onReplyStart,
    onReplyRollback,
  } = usePendingPermissionsQueue(resolvedPermissionSessionId);

  const streamingActorIds = React.useMemo(
    () => agents.map((agent) => agent.actorId),
    [agents],
  );

  const newestActorId = React.useMemo(() => {
    let bestId: string | null = null;
    let bestTs = -1;
    for (const agent of agents) {
      const ts = agent.entry?.lastUpdate ?? 0;
      if (ts >= bestTs) {
        bestTs = ts;
        bestId = agent.actorId;
      }
    }
    return bestId ?? agents[0]?.actorId ?? null;
  }, [agents]);

  const [expandedActorId, setExpandedActorId] = React.useState<string | null>(
    null,
  );
  const [enlargedActorId, setEnlargedActorId] = React.useState<string | null>(
    null,
  );
  const [userPinnedExpand, setUserPinnedExpand] = React.useState(false);

  const hasPendingQuestion = pendingQuestion !== null;
  const questionActorId = React.useMemo(() => {
    if (!pendingQuestion) return null;
    return resolveQuestionAgentId(pendingQuestion, agents);
  }, [agents, pendingQuestion]);

  React.useEffect(() => {
    if (!hasPendingQuestion) return;
    if (questionActorId) {
      setExpandedActorId(questionActorId);
      setEnlargedActorId(null);
    }
  }, [hasPendingQuestion, questionActorId, pendingQuestion?.questionId]);

  React.useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.actorId));
    if (agents.length === 0) {
      if (!hasPendingQuestion) {
        setExpandedActorId(null);
        setEnlargedActorId(null);
        setUserPinnedExpand(false);
      }
      return;
    }
    if (expandedActorId && !ids.has(expandedActorId)) {
      setExpandedActorId(newestActorId);
      setEnlargedActorId(null);
      setUserPinnedExpand(false);
      return;
    }
    if (enlargedActorId && !ids.has(enlargedActorId)) {
      setEnlargedActorId(null);
    }
    if (!userPinnedExpand && !hasPendingQuestion) {
      setExpandedActorId(newestActorId);
    } else if (expandedActorId === null && newestActorId && !hasPendingQuestion) {
      // User closed all panels — stay closed until they open one.
    }
  }, [agents, newestActorId, expandedActorId, enlargedActorId, userPinnedExpand, hasPendingQuestion]);

  const toggleExpand = React.useCallback((actorId: string) => {
    setUserPinnedExpand(true);
    setExpandedActorId((prev) => {
      if (prev === actorId) {
        setEnlargedActorId(null);
        return null;
      }
      setEnlargedActorId(null);
      return actorId;
    });
  }, []);

  const toggleEnlarge = React.useCallback((actorId: string) => {
    setUserPinnedExpand(true);
    setExpandedActorId(actorId);
    setEnlargedActorId((prev) => (prev === actorId ? null : actorId));
  }, []);

  const restoreEnlarge = React.useCallback(() => {
    setEnlargedActorId(null);
  }, []);

  const enlargedAgent = React.useMemo(
    () =>
      enlargedActorId
        ? agents.find(
            (agent) => agent.actorId === enlargedActorId && Boolean(agent.entry),
          )
        : undefined,
    [agents, enlargedActorId],
  );

  const anchorActorId = React.useMemo(
    () => resolveApprovalAnchorActorId(currentEntry, streamingActorIds),
    [currentEntry, streamingActorIds],
  );

  const showApprovalOnly =
    currentEntry !== null &&
    agents.length === 0 &&
    sessionPermissionMode !== "fullAccess" &&
    !hasPendingQuestion;

  const showWaitingOnly =
    currentEntry === null &&
    waitingRequesterActorId !== null &&
    agents.length === 0 &&
    !hasPendingQuestion;

  const hasApproval = currentEntry !== null;
  const hasPermissionChrome =
    hasApproval || waitingRequesterActorId !== null;
  const showAgentSection =
    agents.length > 0 || showApprovalOnly || showWaitingOnly || hasPendingQuestion;
  const showPlan = todos.length > 0 || queue.length > 0;
  const showTopChrome = showAgentSection || showPlan;
  const planRoundsTop = showPlan && !showAgentSection;
  const hideComposerInput = hasPendingQuestion;

  const approvalExpandClasses = cn(
    "grid transition-[grid-template-rows] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
    hasPermissionChrome ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
  );

  const approvalPanelMotionClasses = cn(
    "box-border w-full origin-bottom transition-[transform,opacity] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
    hasPermissionChrome
      ? "translate-y-0 opacity-100 delay-75"
      : "translate-y-3 opacity-0 motion-safe:delay-0",
  );

  return (
    <div
      data-testid="composer-stack"
      className={cn(composerStackShellClass, "relative")}
    >
      {enlargedAgent ? (
        <LiveEnlargeFloat
          agent={enlargedAgent}
          onRestore={restoreEnlarge}
          onInterrupt={onInterrupt}
          showInterrupt={Boolean(onInterrupt) && anchorActorId !== enlargedAgent.actorId}
          suppressQuestionToolCallId={
            hasPendingQuestion && questionActorId === enlargedAgent.actorId
              ? pendingQuestion?.toolCallId
              : undefined
          }
        />
      ) : null}

      {showTopChrome ? (
        <div className="box-border w-full overflow-hidden rounded-t-[14px]">
          {showAgentSection ? (
            <div data-testid="streaming-agents-dock" className="box-border w-full">
              <div
                data-testid="streaming-agent-shell"
                className={cn(
                  "box-border w-full overflow-hidden",
                  hasPermissionChrome && "rounded-t-[14px]",
                  hasPermissionChrome && composerGlassFillClass,
                )}
              >
                <div
                  data-testid="composer-approval-chrome"
                  className={cn(hasPermissionChrome && "rounded-t-[14px]")}
                >
                  <div
                    className={approvalExpandClasses}
                    data-testid="pending-permission-expand"
                    data-open={hasPermissionChrome ? "true" : "false"}
                  >
                    <div className="min-h-0 overflow-hidden">
                      {currentEntry ? (
                        <PermissionApprovalPanel
                          entry={currentEntry}
                          queueIndex={0}
                          queueTotal={queuedCount}
                          onReplyStart={onReplyStart}
                          onReplyRollback={onReplyRollback}
                          appearance="glass"
                          className={cn(
                            approvalPanelMotionClasses,
                            composerStackRowDividerClass,
                          )}
                        />
                      ) : waitingRequesterActorId ? (
                        <PermissionWaitingBanner
                          requesterActorId={waitingRequesterActorId}
                          appearance="glass"
                          className={cn(
                            approvalPanelMotionClasses,
                            composerStackRowDividerClass,
                          )}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>

                {!showApprovalOnly && !showWaitingOnly
                  ? agents.map((agent, index) => {
                      const isAnchor =
                        anchorActorId === agent.actorId && currentEntry !== null;
                      const isQuestionAnchor =
                        hasPendingQuestion && questionActorId === agent.actorId;
                      return (
                        <ComposerAgentStrip
                          key={agent.actorId}
                          actorId={agent.actorId}
                          displayNameHint={agent.displayName}
                          waitingForApproval={isAnchor}
                          waitingForQuestion={isQuestionAnchor}
                          showInterrupt={
                            Boolean(onInterrupt) && !isAnchor && !isQuestionAnchor
                          }
                          onInterrupt={onInterrupt ?? (() => {})}
                          roundsTop={!hasPermissionChrome && index === 0 && !hasPendingQuestion}
                          embeddedInGlass={hasPermissionChrome || hasPendingQuestion}
                          expanded={
                            hasPendingQuestion && isQuestionAnchor
                              ? true
                              : expandedActorId === agent.actorId
                          }
                          enlarged={enlargedActorId === agent.actorId}
                          onToggleExpand={() => toggleExpand(agent.actorId)}
                          onToggleEnlarge={() => toggleEnlarge(agent.actorId)}
                          entry={agent.entry}
                          suppressQuestionToolCallId={
                            isQuestionAnchor ? pendingQuestion?.toolCallId : undefined
                          }
                        />
                      );
                    })
                  : null}

                {hasPendingQuestion && pendingQuestion ? (
                  <QuestionInputDock
                    appearance="stack"
                    pendingQuestion={pendingQuestion}
                    disableEscapeShortcut={Boolean(enlargedActorId)}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {showPlan ? (
            <ComposerPlanSlot
              todos={todos}
              queue={queue}
              onRemoveFromQueue={onRemoveFromQueue}
              roundsTop={planRoundsTop}
              hidden={planSlotHidden}
            />
          ) : null}
        </div>
      ) : null}

      <div
        data-testid="composer-input-zone"
        className={cn(
          "relative z-20",
          composerStackFormSlotClass(showTopChrome),
          hideComposerInput && "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** @deprecated Use ComposerStack — kept for tests importing the old name. */
export const StreamingAgentsBar = ComposerStack;
