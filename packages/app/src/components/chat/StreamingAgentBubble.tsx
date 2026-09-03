import * as React from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  streamTranscriptHasText,
  streamTranscriptRevision,
} from "@/lib/live-agent-stream";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { Message, MessageContent, MessageResponse } from "@/packages/ai/message";
import { useStreamAwaitingNextEvent } from "@/hooks/use-stream-awaiting-next-event";
import { useStreamRevealText } from "@/hooks/use-stream-reveal-text";
import { ToolCallCard } from "./ToolCallCard";
import { ActorLabel } from "./ActorLabel";
import { ThinkingBlock } from "./ThinkingBlock";
import { StreamMarkdown } from "./StreamMarkdown";
import type { MessagePart } from "@/stores/session-types";
import { cn } from "@/lib/utils";

function StreamRevealedResponse({
  text,
  reveal,
}: {
  text: string;
  reveal: boolean;
}) {
  const displayed = useStreamRevealText(text, reveal);
  return (
    <MessageContent>
      {reveal ? (
        <StreamMarkdown text={displayed} />
      ) : (
        <MessageResponse>{displayed}</MessageResponse>
      )}
    </MessageContent>
  );
}

// Plan entries used to render inline here as a card. They now surface in
// the TodoList dock above the prompt input (v1 style) — see `planTodos`
// in ChatPanel.tsx. Removed from the bubble to keep the message stream
// focused on conversation content rather than ephemeral planner state.

function AgentStreamLoadingDots() {
  const { t } = useTranslation();

  return (
    <div
      className="inline-flex items-center gap-[3px] pl-1 py-1"
      data-testid="v2-streaming-planning"
      role="status"
      aria-label={t("common.loading", "Loading…")}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="stream-loading-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </div>
  );
}

function ErrorCard({ message, details }: { message: string; details: string }) {
  return (
    <div
      className="my-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs"
      data-testid="v2-streaming-error"
    >
      <div className="flex items-center gap-1.5 text-destructive font-medium mb-1">
        <AlertCircle className="h-3.5 w-3.5" />
        {message}
      </div>
      {details && (
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground max-h-32 overflow-y-auto">
          {details}
        </pre>
      )}
    </div>
  );
}

function renderOrderedPart(
  part: MessagePart,
  showText: boolean,
  isStreamingReasoning: boolean,
  revealText: boolean,
  skipToolNames?: Set<string>,
  indicatorToolCallIds?: ReadonlySet<string>,
) {
  if (part.type === "reasoning") {
    const text = part.text || part.content || "";
    if (!text) return null;
    return (
      <ThinkingBlock
        key={part.id}
        content={text}
        isStreaming={isStreamingReasoning}
        isOpen={false}
      />
    );
  }

  if (part.type === "tool-call" && part.toolCall) {
    if (skipToolNames?.has(part.toolCall.name)) return null;
    const toolId = part.toolCallId ?? part.toolCall.id;
    const questionPresentation =
      toolId && indicatorToolCallIds?.has(toolId) ? "indicator" : "full";
    return (
      <div
        key={part.id}
        data-testid="v2-streaming-tool"
        data-tool-id={part.toolCall.id}
        data-tool-status={part.toolCall.status}
      >
        <ToolCallCard
          toolCall={part.toolCall}
          questionPresentation={questionPresentation}
        />
      </div>
    );
  }

  if (!showText || part.type !== "text") return null;
  const text = part.text || part.content || "";
  if (!text) return null;
  return (
    <StreamRevealedResponse key={part.id} text={text} reveal={revealText} />
  );
}

// PERF: memoized — the store updates `byKey` immutably, so only the entry
// currently receiving deltas gets a new reference. Without memo every
// revision bump re-renders ALL live bubbles (multi-agent streams multiply
// the cost).
export const StreamingAgentBubble = React.memo(function StreamingAgentBubble({
  entry,
  variant = "default",
  indicatorToolCallIds,
}: {
  entry: AgentStreamEntry;
  /** `dock` hides ActorLabel — Composer agent strip already shows identity. */
  variant?: "default" | "nested" | "dock";
  /** Question tools answered in composer — show compact row in live panel. */
  indicatorToolCallIds?: ReadonlySet<string>;
}) {
  // After finalize (active=false), the persisted AGENT_REPLY ChatMessage
  // takes over the reply text — suppress outputText here to avoid showing
  // the same content twice. Thinking + tool calls stay visible because the
  // daemon doesn't persist those kinds (per turn_aggregator::supabase_persistent),
  // so the bubble is the only place they survive after the turn ends.
  // Plan entries are NOT rendered here — they surface in the TodoList dock
  // above the prompt input (v1 style).
  const isNested = variant === "nested";
  const isDock = variant === "dock";
  const skipToolNames = React.useMemo(
    () => (isNested ? new Set(["task"]) : undefined),
    [isNested],
  );
  const isArchived = "archiveId" in entry;
  const showText = entry.active || !isArchived;
  // PERF: derive parts once per entry change instead of re-filtering the
  // whole parts array (twice) on every render frame.
  const { visibleOrderedParts, hasOrderedThinking, lastLiveTextPartIndex } =
    React.useMemo(() => {
      const ordered = entry.parts.filter(
        (part) =>
          (part.type === "reasoning" && Boolean(part.text || part.content)) ||
          (part.type === "text" && Boolean(part.text || part.content)) ||
          (part.type === "tool-call" && Boolean(part.toolCall)),
      );
      const visible = ordered.filter(
        (part) =>
          part.type === "reasoning" || part.type === "tool-call" || showText,
      );
      let lastText = -1;
      if (entry.active) {
        for (let i = visible.length - 1; i >= 0; i--) {
          if (visible[i]?.type === "text") {
            lastText = i;
            break;
          }
        }
      }
      return {
        visibleOrderedParts: visible,
        hasOrderedThinking: ordered.some((part) => part.type === "reasoning"),
        lastLiveTextPartIndex: lastText,
      };
    }, [entry.parts, entry.active, showText]);
  const hasVisibleOrderedParts = visibleOrderedParts.length > 0;
  const showOutput =
    showText && !hasVisibleOrderedParts && entry.outputText.length > 0;
  const hasFallbackToolCalls = !hasVisibleOrderedParts && entry.toolCalls.length > 0;
  const hasThinking = !hasOrderedThinking && entry.thinkingText.length > 0;
  const hasError = !!entry.errorMessage;

  const transcriptRevision = streamTranscriptRevision(entry);
  const awaitingNextEvent = useStreamAwaitingNextEvent(
    entry.active,
    transcriptRevision,
  );

  const hasTranscriptText = streamTranscriptHasText(entry);

  const [pauseDotsLatched, setPauseDotsLatched] = React.useState(false);
  React.useEffect(() => {
    setPauseDotsLatched(false);
  }, [transcriptRevision]);
  React.useEffect(() => {
    if (!entry.active) {
      setPauseDotsLatched(false);
      return;
    }
    if (awaitingNextEvent && hasTranscriptText) {
      setPauseDotsLatched(true);
    }
  }, [entry.active, awaitingNextEvent, hasTranscriptText]);

  // Nested/dock: nested skips idle dots (TaskToolCard); dock keeps dots for live feel.
  const showStreamLoadingDots = !isNested;
  // Align with agent bar on statusChange ACTIVE — show immediately, no idle debounce.
  const showPlanningInitial =
    showStreamLoadingDots && entry.active && !hasError && !hasTranscriptText;
  const showPlanningAfterPause =
    showStreamLoadingDots &&
    entry.active &&
    !hasError &&
    hasTranscriptText &&
    (awaitingNextEvent || pauseDotsLatched);

  if (
    !showPlanningInitial &&
    !showPlanningAfterPause &&
    !hasVisibleOrderedParts &&
    !showOutput &&
    !hasFallbackToolCalls &&
    !hasThinking &&
    !hasError
  ) {
    return null;
  }

  return (
    <div
      className={cn("group/msg", isDock ? "mb-0" : "mb-1.5")}
      data-testid="v2-streaming-agent"
      data-session-id={entry.sessionId}
      data-actor-id={entry.actorId}
      data-active={entry.active ? "true" : "false"}
      data-variant={variant}
    >
      {!isNested && !isDock ? (
        <ActorLabel senderActorId={entry.actorId} isUser={false} />
      ) : null}
      <Message from="assistant">
        <div className="min-w-0 flex-1">
          {showPlanningInitial ? (
            <div
              className="flex h-[22px] items-center"
              data-testid="v2-streaming-planning-slot"
            >
              <AgentStreamLoadingDots />
            </div>
          ) : null}

          {hasThinking && (
            <ThinkingBlock
              content={entry.thinkingText}
              isStreaming={entry.active}
              isOpen={false}
            />
          )}

          {hasVisibleOrderedParts && (
            <div className="space-y-1">
              {visibleOrderedParts.map((part, index) =>
                renderOrderedPart(
                  part,
                  showText,
                  entry.active &&
                    part.type === "reasoning" &&
                    index === visibleOrderedParts.length - 1,
                  entry.active &&
                    part.type === "text" &&
                    index === lastLiveTextPartIndex,
                  skipToolNames,
                  indicatorToolCallIds,
                ),
              )}
            </div>
          )}

          {hasFallbackToolCalls && (
            <div className="space-y-1">
              {entry.toolCalls
                .filter((tc) => !skipToolNames?.has(tc.name))
                .map((tc) => (
                <div
                  key={tc.id}
                  data-testid="v2-streaming-tool"
                  data-tool-id={tc.id}
                  data-tool-status={tc.status}
                >
                  <ToolCallCard
                    toolCall={tc}
                    questionPresentation={
                      indicatorToolCallIds?.has(tc.id) ? "indicator" : "full"
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {showOutput && (
            <StreamRevealedResponse text={entry.outputText} reveal={entry.active} />
          )}

          {showPlanningAfterPause ? (
            <div
              className="mt-1.5 flex h-[22px] items-center"
              data-testid="v2-streaming-planning-pause-slot"
            >
              <AgentStreamLoadingDots />
            </div>
          ) : null}

          {hasError && (
            <ErrorCard message={entry.errorMessage!} details={entry.errorDetails ?? ""} />
          )}
        </div>
      </Message>
    </div>
  );
});
