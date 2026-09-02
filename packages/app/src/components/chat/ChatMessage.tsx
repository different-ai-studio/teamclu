import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2, ScrollText } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn, copyToClipboard } from "@/lib/utils";
import type { Message as StoreMessage } from "@/stores/session";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/packages/ai/message";
// Leaf imports on purpose: the dynamic-ui barrel pulls the component catalog
// (zod + json-render schema) and the renderer, none of which a message needs
// until it actually carries a UI tree. The renderer loads on first use.
import { extractUITreeFromResponse } from "@/lib/dynamic-ui/generator";
import { parseStreamingUITree } from "@/lib/dynamic-ui/streaming";
import { lazyNamed } from "@/lib/lazy-component";
import { ToolCallCard } from "./ToolCallCard";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { AgentProcessCollapsible } from "./AgentProcessCollapsible";
import { UserMessageWithMentions } from "./UserMessageWithMentions";
import { MessageStatusDot } from "./MessageStatusDot";
import { ActorLabel } from "./ActorLabel";
import { MessageTokenUsage } from "./MessageTokenUsage";
import { MessageTokenSummary } from "./MessageTokenSummary";
import { MessageFeedback } from "./MessageFeedback";
import { MessageStarRating } from "./MessageStarRating";
import { splitAssistantProcessAndFinalParts } from "@/lib/agent-reply-transcript";
import { hydrateDeferredProcessParts } from "@/lib/lazy-process-parts";
import type { MessagePart } from "@/stores/session-types";
import { useSessionMessageStore } from "@/stores/session-message-store";
import {
  AgentReplyQuote,
  jumpToMessageById,
} from "./AgentReplyQuote";
import { ThreadBadge } from "./ThreadBadge";
import { MessageActionIconButton } from "./MessageActionIconButton";
import { useActorDisplayName } from "@/hooks/useActorDisplayName";
import { useCurrentTeamStore } from "@/stores/current-team";

const DynamicUIMessage = lazyNamed(
  () => import("@/lib/dynamic-ui/DynamicUI"),
  "DynamicUIMessage",
);

function formatProcessMetaSummary(meta: {
  toolCount: number;
  hasThinking: boolean;
}): string | undefined {
  const bits: string[] = [];
  if (meta.hasThinking) bits.push("Thinking");
  if (meta.toolCount > 0) bits.push(`${meta.toolCount} tool`);
  return bits.join(" · ") || undefined;
}

function renderAgentProcessPart(part: MessagePart, basePath?: string) {
  if (part.type === "reasoning") {
    const reasoningText = part.text || part.content || "";
    if (!reasoningText) return null;
    return (
      <ThinkingBlock
        key={part.id}
        content={reasoningText}
        isOpen={false}
      />
    );
  }
  if (part.type === "tool-call" && part.toolCall) {
    return <ToolCallCard key={part.id} toolCall={part.toolCall} />;
  }
  if (part.type === "text") {
    const partText = part.text || part.content || "";
    if (!partText) return null;
    return (
      <Message key={part.id} from="assistant" basePath={basePath}>
        <MessageContent>
          <MessageResponse>{partText}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }
  return null;
}

/** Renders a single message with all its parts. Memoized to avoid re-renders when siblings change. */
export const ChatMessage = React.memo(function ChatMessage({
  message,
  activeSessionId,
  basePath,
  shouldShowThinking = true,
  showStarRating = false,
  suppressThreadBadge = false,
  allowStartThread = true,
  tokenGroupInfo,
  replyToMessage,
}: {
  message: StoreMessage;
  activeSessionId?: string | null;
  basePath?: string;
  shouldShowThinking?: boolean;
  showStarRating?: boolean;
  /** Hide "+ 开话题" when rendering a thread anchor (avoids nested panel loops). */
  suppressThreadBadge?: boolean;
  /** Hide fork affordance when anchor is outside the newest message window. */
  allowStartThread?: boolean;
  tokenGroupInfo?: {
    hideTokenUsage: boolean;
    groupSummary?: { steps: number; totalInput: number; totalOutput: number; totalCost: number };
  };
  /** Parent user message when this assistant turn quotes one. */
  replyToMessage?: StoreMessage | null;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const isInterruptedTurn = !isUser && message.turnStatus === "interrupted";
  const isNoFinalReplyTurn = !isUser && message.turnStatus === "no_final_reply";
  const isUnsupportedNativeSkillTurn =
    !isUser && message.turnStatus === "skill_created_in_unsupported_directory";
  const [copied, setCopied] = React.useState(false);
  const [hydratedProcessParts, setHydratedProcessParts] = React.useState<
    MessagePart[] | null
  >(null);
  const [processHydrating, setProcessHydrating] = React.useState(false);
  const replyAuthorResolved = useActorDisplayName(replyToMessage?.senderActorId);
  const myActorId = useCurrentTeamStore((s) => s.currentMember?.id);
  const isSelfUser = Boolean(
    isUser &&
      myActorId &&
      message.senderActorId &&
      message.senderActorId === myActorId,
  );
  const replyAuthorName = React.useMemo(() => {
    if (!replyToMessage) return "";
    if (
      myActorId &&
      replyToMessage.senderActorId &&
      replyToMessage.senderActorId === myActorId
    ) {
      return t("chat.you", "你");
    }
    return replyAuthorResolved || t("chat.someone", "某人");
  }, [replyToMessage, myActorId, replyAuthorResolved, t]);

  // Live agent output is rendered by the v2 stream bubbles
  // (StreamingAgentBubble); a persisted ChatMessage always shows its own
  // content.
  const latestMessage = message;
  const textContent = latestMessage.content || "";

  const isDeferredProcess =
    !latestMessage.isStreaming && Boolean(latestMessage.processDeferred);

  React.useEffect(() => {
    setHydratedProcessParts(null);
    setProcessHydrating(false);
  }, [latestMessage.id, latestMessage.processDeferred]);

  const handleProcessOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open || !isDeferredProcess || hydratedProcessParts) return;
      setProcessHydrating(true);
      void Promise.resolve().then(() => {
        const protos =
          useSessionMessageStore.getState().messages[latestMessage.sessionId];
        const parts = hydrateDeferredProcessParts(protos, latestMessage);
        setHydratedProcessParts(parts);
        setProcessHydrating(false);
      });
    },
    [hydratedProcessParts, isDeferredProcess, latestMessage],
  );

  // Extract reasoning/thinking content from parts — memoized to avoid
  // re-filtering on every render during streaming.
  const { reasoningContent, hasReasoning, hasThinking } = React.useMemo(() => {
    const rParts = latestMessage.parts.filter((p) => p.type === "reasoning");
    const rContent = rParts.map((p) => p.text || "").filter(Boolean).join("\n");
    return {
      reasoningContent: rContent,
      hasReasoning: rContent.length > 0,
      hasThinking: latestMessage.parts.some(
        (p) => p.type === "step-start" || p.type === "step-finish",
      ),
    };
  }, [latestMessage.parts]);

  const hasToolCalls = latestMessage.toolCalls && latestMessage.toolCalls.length > 0;
  const orderedRenderableParts = React.useMemo(
    () =>
      latestMessage.parts.filter(
        (p) =>
          (p.type === "reasoning" && Boolean(p.text || p.content)) ||
          (p.type === "text" && Boolean(p.text || p.content)) ||
          (p.type === "tool-call" && Boolean(p.toolCall)),
      ),
    [latestMessage.parts],
  );
  const hasOrderedToolParts = orderedRenderableParts.some((p) => p.type === "tool-call");
  const hasOrderedReasoningParts = orderedRenderableParts.some((p) => p.type === "reasoning");
  const { processParts: orderedProcessParts, finalTextParts: orderedTextParts } =
    React.useMemo(
      () => splitAssistantProcessAndFinalParts(orderedRenderableParts),
      [orderedRenderableParts],
    );
  const shouldRenderOrderedAssistantParts =
    !isUser &&
    (hasOrderedToolParts ||
      (hasOrderedReasoningParts &&
        (orderedRenderableParts.some((p) => p.type === "text") || !textContent)));

  const fallbackProcessSummary = React.useMemo(() => {
    const bits: string[] = [];
    if (hasReasoning) bits.push("Thinking");
    if (hasToolCalls && !hasOrderedToolParts) {
      bits.push(`${latestMessage.toolCalls!.length} tool`);
    }
    return bits.join(" · ") || undefined;
  }, [hasReasoning, hasToolCalls, hasOrderedToolParts, latestMessage.toolCalls]);

  const orderedProcessSummary = React.useMemo(() => {
    const toolCount = orderedProcessParts.filter((p) => p.type === "tool-call").length;
    const bits: string[] = [];
    if (hasOrderedReasoningParts) bits.push("Thinking");
    if (toolCount > 0) bits.push(`${toolCount} tool`);
    return bits.join(" · ") || undefined;
  }, [orderedProcessParts, hasOrderedReasoningParts]);

  const hasActiveToolCalls =
    latestMessage.toolCalls?.some(
      (tc) => tc.status === "calling" || tc.status === "waiting",
    ) ?? false;

  const showThinkingOnly =
    !isUser &&
    !textContent &&
    (hasThinking || hasReasoning) &&
    latestMessage.isStreaming &&
    !hasActiveToolCalls &&
    shouldShowThinking;

  const showLoadingIndicator =
    !isUser &&
    !isInterruptedTurn &&
    !textContent &&
    !hasThinking &&
    !hasReasoning &&
    !hasToolCalls &&
    latestMessage.isStreaming &&
    shouldShowThinking;

  // Try to extract UITree from assistant message
  const uiState = React.useMemo(() => {
    if (isUser || !textContent)
      return { tree: null, isComplete: false, elementCount: 0 };

    if (latestMessage.isStreaming) {
      return parseStreamingUITree(textContent);
    } else {
      const tree = extractUITreeFromResponse(textContent);
      return {
        tree,
        isComplete: true,
        elementCount: tree ? Object.keys(tree.elements).length : 0,
      };
    }
  }, [isUser, latestMessage.isStreaming, textContent]);

  const uiTree = uiState.tree;
  const isStreamingUI = latestMessage.isStreaming && uiTree !== null;

  // Tool-call-only messages get tighter spacing
  const isToolCallOnly = !isUser && !textContent && hasToolCalls && !hasReasoning && !showLoadingIndicator;

  const handleCopy = React.useCallback(async () => {
    if (!textContent.trim()) return;
    await copyToClipboard(textContent, t("common.copied", "Copied!"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [textContent, t]);

  const shouldShowAssistantCopyAction =
    !isUser &&
    !latestMessage.isStreaming &&
    Boolean(textContent) &&
    !(tokenGroupInfo?.hideTokenUsage ?? false);

  if (latestMessage.hidden || latestMessage.displayKind === "synthetic" || latestMessage.displayKind === "compaction-summary") {
    return null;
  }

  if (latestMessage.displayKind === "compaction") {
    const completed = latestMessage.compaction?.completed !== false;
    const title = completed
      ? t("chat.compaction.title", "Context automatically compacted")
      : t("chat.compaction.inProgressTitle", "Compacting context automatically...");

    return (
      <div
        className="group/msg my-4 flex items-center gap-3 text-muted-foreground"
        data-testid="chat-message"
        data-message-id={message.id}
        data-message-role={message.role}
        data-message-kind="compaction"
      >
        <div className="h-px min-w-8 flex-1 bg-border/80" />
        <div className="flex min-w-0 max-w-[70%] items-center gap-2 text-sm font-medium text-muted-foreground">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {completed ? (
              <ScrollText className="h-4 w-4" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
          </span>
          <span className="truncate">{title}</span>
        </div>
        <div className="h-px min-w-8 flex-1 bg-border/80" />
      </div>
    );
  }

  return (
    <div
      className={cn("group/msg", isToolCallOnly ? "mb-0.5" : "mb-1.5")}
      data-testid="chat-message"
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <ActorLabel
        senderActorId={message.senderActorId}
        modelOverride={message.modelID}
        isUser={isUser}
        nameOverride={
          isSelfUser ? t("chat.you", "你") : undefined
        }
      />
      {!isUser && replyToMessage ? (
        <AgentReplyQuote
          authorName={replyAuthorName}
          content={replyToMessage.content || ""}
          onJump={() => jumpToMessageById(replyToMessage.id)}
        />
      ) : null}

      {/* Deferred historical process — hydrate on expand */}
      {!isUser && isDeferredProcess && latestMessage.processMeta ? (
        <div className="mb-0.5 pl-1">
          <AgentProcessCollapsible
            summary={formatProcessMetaSummary(latestMessage.processMeta)}
            loading={processHydrating}
            onOpenChange={handleProcessOpenChange}
          >
            {hydratedProcessParts?.map((part) => renderAgentProcessPart(part, basePath))}
          </AgentProcessCollapsible>
        </div>
      ) : null}

      {/* Reasoning / tools — collapsed「处理过程」above final text when not streaming */}
      {!isUser &&
        !isDeferredProcess &&
        !latestMessage.isStreaming &&
        !shouldRenderOrderedAssistantParts &&
        (hasReasoning || (hasToolCalls && !hasOrderedToolParts)) && (
          <div className="mb-0.5 pl-1">
            <AgentProcessCollapsible summary={fallbackProcessSummary}>
              {hasReasoning ? (
                <ThinkingBlock content={reasoningContent} isOpen={false} />
              ) : null}
              {hasToolCalls && !hasOrderedToolParts
                ? latestMessage.toolCalls!.map((toolCall) => (
                    <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                  ))
                : null}
            </AgentProcessCollapsible>
          </div>
        )}

      {/* Streaming-only thinking indicator (live path uses Composer dock) */}
      {showThinkingOnly && !hasReasoning && (
        <div className="flex items-start gap-2 pl-1 mb-2">
          <ThinkingBlock
            content={t("chat.analyzing", "Agent is analyzing and planning...")}
            isStreaming={true}
            isOpen={false}
          />
        </div>
      )}

      {/* Loading indicator */}
      {showLoadingIndicator && (
        <div className="mt-2">
          <Message from="assistant" basePath={basePath}>
            <MessageContent>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm shimmer-text">{t("chat.planningMoves", "Planning next moves")}</span>
              </div>
            </MessageContent>
          </Message>
        </div>
      )}

      {/* Legacy streaming reasoning (v1) — keep above content while streaming */}
      {!isUser &&
        hasReasoning &&
        !hasOrderedReasoningParts &&
        latestMessage.isStreaming && (
        <div className="mb-0.5">
          <ThinkingBlock
            content={reasoningContent}
            isStreaming={!textContent && !hasToolCalls}
            isOpen={false}
          />
        </div>
      )}

      {/* User message — Message itself is `flex justify-end`; render the
          status dot as its first child so the dot sits to the LEFT of the
          bubble while MessageContent width cap keeps the bubble properly
          sized (self: max-w-[85%], other: max-w-[65%]).
          Wrapping the Message in another flex container collapsed it to
          min-content and made each character wrap). */}
      {isUser && (
        <Message
          from="user"
          basePath={basePath}
          userBubble={isSelfUser ? "self" : "other"}
          className="items-end gap-1.5"
        >
          <MessageStatusDot messageId={message.id} />
          <MessageContent>
            <UserMessageWithMentions
              content={textContent}
              basePath={basePath}
              leadingMentionActorIds={latestMessage.mentionActorIds}
              mentionDeliverySnapshot={latestMessage.mentionDeliverySnapshot}
              userBubble={isSelfUser ? "self" : "other"}
            />
          </MessageContent>
        </Message>
      )}

      {/* User message actions */}
      {isUser && !latestMessage.isStreaming && (
        <div className={cn("flex justify-end mt-1 pr-1 transition-opacity", copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100")}>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
            title={copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}</span>
          </button>
        </div>
      )}

      {/* Assistant message - either dynamic UI or text */}
      {!isUser && shouldRenderOrderedAssistantParts && !isDeferredProcess && (
        <div className="mt-2 space-y-1">
          {orderedProcessParts.length > 0 && !latestMessage.isStreaming ? (
            <AgentProcessCollapsible summary={orderedProcessSummary}>
              {orderedProcessParts.map((part) => {
                if (part.type === "reasoning") {
                  const reasoningText = part.text || part.content || "";
                  if (!reasoningText) return null;
                  return (
                    <ThinkingBlock
                      key={part.id}
                      content={reasoningText}
                      isOpen={false}
                    />
                  );
                }
                if (part.type === "tool-call" && part.toolCall) {
                  return <ToolCallCard key={part.id} toolCall={part.toolCall} />;
                }
                if (part.type === "text") {
                  const partText = part.text || part.content || "";
                  if (!partText) return null;
                  return (
                    <Message key={part.id} from="assistant" basePath={basePath}>
                      <MessageContent>
                        <MessageResponse>{partText}</MessageResponse>
                      </MessageContent>
                    </Message>
                  );
                }
                return null;
              })}
            </AgentProcessCollapsible>
          ) : null}
          {(latestMessage.isStreaming
            ? orderedRenderableParts
            : orderedTextParts
          ).map((part, index, arr) => {
            if (part.type === "reasoning") {
              if (!latestMessage.isStreaming) return null;
              const reasoningText = part.text || part.content || "";
              if (!reasoningText) return null;
              return (
                <ThinkingBlock
                  key={part.id}
                  content={reasoningText}
                  isStreaming={
                    index === arr.length - 1 && !textContent
                  }
                  isOpen={false}
                />
              );
            }
            if (part.type === "tool-call" && part.toolCall) {
              if (!latestMessage.isStreaming) return null;
              return <ToolCallCard key={part.id} toolCall={part.toolCall} />;
            }
            if (part.type !== "text") return null;
            const partText = part.text || part.content || "";
            if (!partText) return null;
            const isGrowingPart =
              latestMessage.isStreaming && index === arr.length - 1;
            return (
              <Message key={part.id} from="assistant" basePath={basePath}>
                <MessageContent>
                  {isGrowingPart ? (
                    <StreamMarkdown text={partText} />
                  ) : (
                    <MessageResponse>{partText}</MessageResponse>
                  )}
                </MessageContent>
              </Message>
            );
          })}
          {!latestMessage.isStreaming &&
            orderedTextParts.length === 0 &&
            textContent &&
            // Mid-turn narrations already live inside process; don't re-render
            // message.content as a duplicate final body.
            !orderedProcessParts.some((part) => part.type === "text") && (
              <Message from="assistant" basePath={basePath}>
                <MessageContent>
                  <MessageResponse>{textContent}</MessageResponse>
                </MessageContent>
              </Message>
            )}
          {latestMessage.isStreaming && textContent && (
            <span className="inline-flex items-center gap-0.5 ml-1.5 align-middle">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_infinite]" />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.2s_infinite]" />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.4s_infinite]" />
            </span>
          )}
        </div>
      )}

      {!isUser && !shouldRenderOrderedAssistantParts && textContent && (
        <>
          {uiTree ? (
            <div className="mt-2">
              <ErrorBoundary scope="Dynamic UI" inline>
                <React.Suspense fallback={null}>
                  <DynamicUIMessage tree={uiTree} loading={isStreamingUI} />
                </React.Suspense>
              </ErrorBoundary>
              {isStreamingUI && (
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <span>{t("chat.generatingComponents", "Generating... ({{count}} components)", { count: uiState.elementCount })}</span>
                </div>
              )}
            </div>
          ) : (
            <Message from="assistant" basePath={basePath}>
              <MessageContent>
                {latestMessage.isStreaming ? (
                  <StreamMarkdown text={textContent} />
                ) : (
                  <MessageResponse>{textContent}</MessageResponse>
                )}
                {latestMessage.isStreaming && textContent && (
                  <span className="inline-flex items-center gap-0.5 ml-1.5 align-middle">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_infinite]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.2s_infinite]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-[bounce_1s_ease-in-out_0.4s_infinite]" />
                  </span>
                )}
              </MessageContent>
            </Message>
          )}
        </>
      )}

      {/* Daemon interrupted AGENT_REPLY — after process/tools, scheme A */}
      {isInterruptedTurn ? (
        <div
          className="mt-1 flex max-w-[520px] flex-wrap items-baseline gap-x-2 gap-y-1 pl-1 text-[12.5px] leading-[1.5] text-ink-2"
          data-testid="interrupted-agent-reply"
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-[1px] bg-muted-foreground/70"
            aria-hidden
          />
          <span className="font-semibold">
            {t("chat.interrupt.stoppedTitle", "Stopped")}
          </span>
          <span className="font-mono text-[11px] text-faint">
            · {t("chat.interrupt.interruptedStatusLabel", "interrupted")}
          </span>
          <p className="mt-0.5 w-full text-[12.5px] leading-[1.55] text-muted-foreground">
            {t(
              "chat.interrupt.agentReplyBodyKept",
              "You interrupted this reply. Generated content is kept.",
            )}
          </p>
        </div>
      ) : null}

      {/* Daemon no_final_reply AGENT_REPLY — tool-complete without prose */}
      {isNoFinalReplyTurn ? (
        <div
          className="mt-1 flex max-w-[520px] flex-wrap items-baseline gap-x-2 gap-y-1 pl-1 text-[12.5px] leading-[1.5] text-ink-2"
          data-testid="no-final-reply"
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-[1px] bg-muted-foreground/70"
            aria-hidden
          />
          <span className="font-semibold">
            {t("chat.noFinalReply.finishedTitle", "Turn finished")}
          </span>
          <span className="font-mono text-[11px] text-faint">
            · {t("chat.noFinalReply.statusLabel", "no final reply")}
          </span>
          <p className="mt-0.5 w-full text-[12.5px] leading-[1.55] text-muted-foreground">
            {t(
              "chat.noFinalReply.description",
              "No additional written reply was produced.",
            )}
          </p>
        </div>
      ) : null}

      {/* Daemon unsupported native skill AGENT_REPLY — fail-closed turn outcome */}
      {isUnsupportedNativeSkillTurn ? (
        <div
          className="mt-1 flex max-w-[520px] flex-wrap items-baseline gap-x-2 gap-y-1 pl-1 text-[12.5px] leading-[1.5] text-ink-2"
          data-testid="unsupported-native-skill-reply"
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-[1px] bg-destructive/80"
            aria-hidden
          />
          <span className="font-semibold">
            {t("chat.unsupportedNativeSkill.failedTitle", "Skill not created")}
          </span>
          <span className="font-mono text-[11px] text-faint">
            ·{" "}
            {t(
              "chat.unsupportedNativeSkill.statusLabel",
              "unsupported directory",
            )}
          </span>
          <p className="mt-0.5 w-full text-[12.5px] leading-[1.55] text-muted-foreground">
            {t(
              "chat.unsupportedNativeSkill.description",
              "A skill was written under a native agent directory instead of through manage_skills. Remove the native copy and recreate with manage_skills action=create.",
            )}
          </p>
          {(message.nativeSkillViolations ?? []).map((v) => (
            <p
              key={`${v.slug}-${v.root}`}
              className="w-full font-mono text-[11px] text-faint"
            >
              {v.slug} · {v.root}
            </p>
          ))}
        </div>
      ) : null}

      {!isUser && activeSessionId && !latestMessage.isStreaming ? (
        <ThreadBadge
          parentSessionId={activeSessionId}
          messageId={message.id}
          message={latestMessage}
          hideThread={suppressThreadBadge}
          allowStartThread={allowStartThread}
          actionsRevealed={copied}
          copySlot={
            shouldShowAssistantCopyAction ? (
              <MessageActionIconButton
                label={copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}
                onClick={handleCopy}
                testId="message-copy-action"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </MessageActionIconButton>
            ) : null
          }
        />
      ) : null}

      {/* Tool calls — only while streaming on fallback path; completed uses process shell above */}
      {!isUser &&
        hasToolCalls &&
        !hasOrderedToolParts &&
        latestMessage.isStreaming && (
        <div className="mt-1 space-y-0.5 pl-1">
          {latestMessage.toolCalls!.map((toolCall) => (
            <ToolCallCard key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}

      {/* Token usage summary + feedback for assistant messages */}
      {!isUser && !latestMessage.isStreaming && latestMessage.tokens && !tokenGroupInfo?.hideTokenUsage && (
        <div className="pl-1 group">
          <div className="flex items-start gap-2">
            {tokenGroupInfo?.groupSummary ? (
              <MessageTokenSummary summary={tokenGroupInfo.groupSummary} />
            ) : (
              <MessageTokenUsage tokens={latestMessage.tokens} cost={latestMessage.cost} />
            )}
            <div className="mt-1">
              <MessageFeedback
                sessionId={latestMessage.sessionId}
                messageId={latestMessage.id}
              />
            </div>
          </div>
          {showStarRating && (
            <MessageStarRating
              sessionId={latestMessage.sessionId}
              messageId={latestMessage.id}
            />
          )}
        </div>
      )}
    </div>
  );
});
