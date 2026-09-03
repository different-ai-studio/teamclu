import * as React from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import { useSessionStore } from "@/stores/session-store";
import { type Message } from "@/stores/session-types";
import { useSessionListStore } from "@/stores/session-list-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./ChatMessage";
import { useChatStickToBottom } from "@/hooks/use-chat-stick-to-bottom";
import {
  CHAT_SCROLL_TO_MESSAGE_EVENT,
  findChatMessageElement,
  flashChatMessage,
  scrollChatMessageIntoView,
  type ChatScrollToMessageDetail,
} from "@/lib/ui/chat-scroll-to-message";
import { DEFAULT_INPUT_AREA_HEIGHT, SAFE_BOTTOM_SPACING } from "./layout-constants";
import { canStartThreadFromNewestIndex } from "@/lib/session/thread-fork";

// ─── Constants ────────────────────────────────────────────────────────────────

// Virtualize long threads (>80 messages). Matches INITIAL_VISIBLE_MESSAGE_COUNT
// so the windowed "load earlier" path and the virtualizer engage together.
// Dynamic heights via measureElement + messageAreaWidth remeasure; smoke-test
// open a >80-message session, toggle sidebar / resize, confirm no row overlap.
export const VIRTUAL_MSG_THRESHOLD = 80;
const INITIAL_VISIBLE_MESSAGE_COUNT = 80;
const LOAD_EARLIER_MESSAGE_COUNT = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

interface MessageListProps {
  messages: Message[];
  activeSessionId: string | null;
  isStreaming: boolean;
  streamingMessageId: string | null;
  compact?: boolean;
  sessionDirectory?: string;
  /** Optional empty-state content rendered when there are no messages (not loading) */
  emptyState?: React.ReactNode;
  /** Composer lives outside MessageList (e.g. thread panel) — skip main-chat bottom inset. */
  externalComposer?: boolean;
  /** Optional content rendered at the bottom of the scrollable message area. */
  bottomContent?: React.ReactNode;
  /** Hide "+ Open thread" on agent replies (e.g. inside ThreadPanel). */
  suppressThreadBadge?: boolean;
}

export interface MessageListHandle {
  /** Notify the message list that the input area height changed (for bottom padding) */
  handleInputHeightChange: (height: number) => void;
  /** Pin the viewport to the latest user message row (call right after optimistic append). */
  scrollToLatestMessage: (messageId?: string) => void;
  /** Stop stick-to-bottom while the user is reading above the composer. */
  pauseAutoFollowIfReading: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

const MessageListInner = React.forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages: rawMessages,
      activeSessionId,
      isStreaming,
      streamingMessageId: _streamingMessageId,
      compact = false,
      sessionDirectory,
      emptyState,
      externalComposer = false,
      bottomContent,
      suppressThreadBadge = false,
    },
    ref,
  ) {
    const { t } = useTranslation();

    // ── Store selectors ──────────────────────────────────────────────────
    const isLoading = useSessionListStore((s) => s.loading);
    const v2StreamScrollTrigger = useV2StreamingStore((s) =>
      activeSessionId ? (s.revisionBySession[activeSessionId] ?? 0) : 0,
    );

    // PERF: Return primitive string instead of session object.
    // Object references from .find() change on every sessions update → unnecessary re-renders.
    // Use `activeSessionId` prop (may lag store during ChatPanel fade) so paths match shown messages.
    const activeSessionDirectory = useSessionStore((s) =>
      sessionDirectory ??
      (activeSessionId
        ? s.sessions.find((ss) => ss.id === activeSessionId)?.directory
        : undefined),
    );

    // ── Sorted messages ──────────────────────────────────────────────────
    const messages = React.useMemo(() => {
      const msgs = rawMessages || [];
      // Stable sort, no id tiebreak: same-timestamp messages keep the order the
      // adapter produced. Comparing ids would reorder a gateway user message and
      // its reply arbitrarily (WeCom msgid vs. random UUID).
      return [...msgs].sort((a, b) => {
        const ta = a.timestamp?.getTime?.() ?? 0;
        const tb = b.timestamp?.getTime?.() ?? 0;
        return ta - tb;
      });
    }, [rawMessages]);

    const [visibleMessageCount, setVisibleMessageCount] = React.useState(INITIAL_VISIBLE_MESSAGE_COUNT);
    React.useEffect(() => {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGE_COUNT);
    }, [activeSessionId]);

    React.useEffect(() => {
      setVisibleMessageCount((count) => Math.max(INITIAL_VISIBLE_MESSAGE_COUNT, Math.min(count, messages.length)));
    }, [messages.length]);

    const hiddenMessageCount = Math.max(0, messages.length - visibleMessageCount);
    const loadEarlierCount = Math.min(LOAD_EARLIER_MESSAGE_COUNT, hiddenMessageCount);
    const loadEarlierLabel = React.useMemo(
      () =>
        t("chat.loadEarlierMessages", "Load {{count}} earlier messages", {
          count: loadEarlierCount,
        }).replace("{{count}}", String(loadEarlierCount)),
      [loadEarlierCount, t],
    );
    const renderedMessages = React.useMemo(
      () => messages.slice(Math.max(0, messages.length - visibleMessageCount)),
      [messages, visibleMessageCount],
    );

    // ── Token group info ─────────────────────────────────────────────────
    // Compute token group summaries: consecutive assistant messages are grouped.
    // Intermediate messages hide individual tokens; the last in a group shows aggregate.
    const tokenGroupInfo = React.useMemo(() => {
      const info = new Map<
        string,
        {
          hideTokenUsage: boolean;
          groupSummary?: {
            steps: number;
            totalInput: number;
            totalOutput: number;
            totalCost: number;
          };
        }
      >();
      let groupStart = -1;
      for (let i = 0; i <= renderedMessages.length; i++) {
        const msg = renderedMessages[i];
        const isAssistant = msg && msg.role !== "user";
        if (!isAssistant || i === renderedMessages.length) {
          // End of a group — finalize
          if (groupStart !== -1) {
            const groupEnd = i - 1;
            const groupLen = groupEnd - groupStart + 1;
            const groupHasStreaming = renderedMessages
              .slice(groupStart, groupEnd + 1)
              .some((groupMessage) => groupMessage.isStreaming);

            if (groupHasStreaming) {
              for (let j = groupStart; j <= groupEnd; j++) {
                info.set(renderedMessages[j].id, { hideTokenUsage: true });
              }
            } else if (groupLen > 1) {
              let totalInput = 0,
                totalOutput = 0,
                totalCost = 0;
              for (let j = groupStart; j <= groupEnd; j++) {
                const toks = renderedMessages[j].tokens;
                if (toks) {
                  totalInput += toks.input;
                  totalOutput += toks.output;
                }
                if (renderedMessages[j].cost) totalCost += renderedMessages[j].cost!;
              }
              for (let j = groupStart; j < groupEnd; j++) {
                info.set(renderedMessages[j].id, { hideTokenUsage: true });
              }
              info.set(renderedMessages[groupEnd].id, {
                hideTokenUsage: false,
                groupSummary: {
                  steps: groupLen,
                  totalInput,
                  totalOutput,
                  totalCost,
                },
              });
            }
            // Single-message groups keep default behavior (no entry in map)
          }
          groupStart = -1;
        } else if (groupStart === -1) {
          groupStart = i;
        }
      }
      return info;
    }, [renderedMessages]);

    // Full timeline — parent of a quote may sit above the visible window.
    const messagesById = React.useMemo(() => {
      const map = new Map<string, Message>();
      for (const message of messages) {
        map.set(message.id, message);
      }
      return map;
    }, [messages]);

    // ── Local state ──────────────────────────────────────────────────────
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [inputAreaHeight, setInputAreaHeight] = React.useState(DEFAULT_INPUT_AREA_HEIGHT);
    const [messageAreaWidth, setMessageAreaWidth] = React.useState(0);
    // ── Refs ─────────────────────────────────────────────────────────────
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const messageAreaRef = React.useRef<HTMLDivElement>(null);
    const prevStreamingRef = React.useRef(false);
    const pendingScrollMessageIdRef = React.useRef<string | null>(null);

    const {
      scrollToBottom,
      scrollToBottomIfAtBottom,
      scrollToBottomAfterCommit,
      observeContentResize,
      onScroll,
      enableAutoFollow,
      pauseAutoFollowIfReading,
      stopAutoFollow,
    } = useChatStickToBottom(scrollRef);

    const fulfillPendingScroll = React.useCallback(() => {
      const messageId = pendingScrollMessageIdRef.current;
      if (!messageId) return;
      const el = findChatMessageElement(messageId);
      if (!el) return;
      scrollChatMessageIntoView(el);
      flashChatMessage(el);
      pendingScrollMessageIdRef.current = null;
    }, []);

    /**
     * Called from ChatPanel right after optimistic append.
     * Scrolls to `scrollHeight - clientHeight` after React commits the new
     * message. The `messageArea` paddingBottom = `inputAreaHeight +
     * SAFE_BOTTOM_SPACING` ensures the new bubble lands just above the
     * floating chat input — not behind it.
     */
    const scrollToLatestMessage = React.useCallback(
      (_messageId?: string) => {
        scrollToBottomAfterCommit();
      },
      [scrollToBottomAfterCommit],
    );

    // ── Imperative handle ────────────────────────────────────────────────
    const handleInputHeightChange = React.useCallback(
      (height: number) => {
        setInputAreaHeight((prev) => (prev === height ? prev : height));
        // Composer chrome (approval, multiline) must not yank readers back to bottom.
        requestAnimationFrame(() => {
          scrollToBottomIfAtBottom();
        });
      },
      [scrollToBottomIfAtBottom],
    );

    React.useImperativeHandle(
      ref,
      () => ({
        handleInputHeightChange,
        scrollToLatestMessage,
        pauseAutoFollowIfReading,
      }),
      [handleInputHeightChange, scrollToLatestMessage, pauseAutoFollowIfReading],
    );

    React.useLayoutEffect(() => {
      const el = messageAreaRef.current;
      if (!el) return;

      const updateWidth = () => {
        const nextWidth = Math.round(el.getBoundingClientRect().width);
        setMessageAreaWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      };

      updateWidth();

      const observer = new ResizeObserver(() => {
        updateWidth();
      });

      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    // ── Virtual scrolling ────────────────────────────────────────────────
    const useVirtualMessages = messages.length > VIRTUAL_MSG_THRESHOLD;

    const messageVirtualizer = useVirtualizer({
      count: useVirtualMessages ? renderedMessages.length : 0,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => 150,
      overscan: 5,
      gap: 4,
    });

    React.useLayoutEffect(() => {
      if (!useVirtualMessages || messageAreaWidth <= 0) return;

      const raf = requestAnimationFrame(() => {
        messageVirtualizer.measure();
      });

      return () => cancelAnimationFrame(raf);
    }, [useVirtualMessages, messageAreaWidth, messageVirtualizer]);

    React.useEffect(() => {
      const onScrollRequest = (event: Event) => {
        const messageId = (event as CustomEvent<ChatScrollToMessageDetail>).detail
          ?.messageId;
        if (!messageId) return;

        stopAutoFollow();
        pendingScrollMessageIdRef.current = messageId;

        const idx = messages.findIndex((message) => message.id === messageId);
        if (idx < 0) {
          pendingScrollMessageIdRef.current = null;
          return;
        }

        const firstRenderedIndex = Math.max(0, messages.length - visibleMessageCount);
        if (idx < firstRenderedIndex) {
          setVisibleMessageCount(messages.length - idx);
          return;
        }

        if (useVirtualMessages) {
          const renderedIndex = renderedMessages.findIndex(
            (message) => message.id === messageId,
          );
          if (renderedIndex >= 0) {
            messageVirtualizer.scrollToIndex(renderedIndex, {
              align: "start",
              behavior: "smooth",
            });
          }
        }

        requestAnimationFrame(() => {
          requestAnimationFrame(fulfillPendingScroll);
        });
      };

      window.addEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, onScrollRequest);
      return () => {
        window.removeEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, onScrollRequest);
      };
    }, [
      fulfillPendingScroll,
      messageVirtualizer,
      messages,
      renderedMessages,
      stopAutoFollow,
      useVirtualMessages,
      visibleMessageCount,
    ]);

    React.useEffect(() => {
      if (!pendingScrollMessageIdRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(fulfillPendingScroll);
      });
    }, [fulfillPendingScroll, renderedMessages, visibleMessageCount]);

    // ── Scroll management (stick-to-bottom + ResizeObserver) ─────────────

    // Primary auto-scroll driver: when content grows (messages or streaming),
    // scroll to the absolute bottom if we're currently "at bottom".
    React.useEffect(
      () => observeContentResize(messageAreaRef),
      [observeContentResize, activeSessionId],
    );

    // When v1 streaming starts, scroll to bottom if already following.
    React.useEffect(() => {
      const wasStreaming = prevStreamingRef.current;
      if (isStreaming && !wasStreaming) {
        scrollToBottomIfAtBottom();
      }
      prevStreamingRef.current = isStreaming;
    }, [isStreaming, scrollToBottomIfAtBottom]);

    // When v2 / child streaming content updates, scroll if following.
    // ResizeObserver is the primary driver in real browsers; this is the
    // fallback for JSDOM (tests) where ResizeObserver does not fire.
    React.useEffect(() => {
      if (v2StreamScrollTrigger > 0) {
        scrollToBottomIfAtBottom();
      }
    }, [v2StreamScrollTrigger, scrollToBottomIfAtBottom]);

    // After a persisted agent reply lands in the list, re-pin to the bottom
    // once layout commits (stream bubble may shrink/move in the same tick).
    const prevMessageCountRef = React.useRef(messages.length);
    React.useEffect(() => {
      const grew = messages.length > prevMessageCountRef.current;
      prevMessageCountRef.current = messages.length;
      if (grew) {
        scrollToBottomAfterCommit();
      }
    }, [messages.length, scrollToBottomAfterCommit]);

    const prevSessionIdRef = React.useRef(activeSessionId);
    const needsScrollAfterLoadRef = React.useRef(false);
    React.useEffect(() => {
      if (activeSessionId !== prevSessionIdRef.current) {
        prevSessionIdRef.current = activeSessionId;
        enableAutoFollow();
        setShowScrollButton(false);
        setInputAreaHeight(DEFAULT_INPUT_AREA_HEIGHT);
        needsScrollAfterLoadRef.current = true;
      }
    }, [activeSessionId, enableAutoFollow]);

    const storeActiveSessionId = useSessionStore((s) => s.activeSessionId);

    // Load feedback for the store-active session (not the lagging display id during fade)
    React.useEffect(() => {
      if (storeActiveSessionId) {
        import("@/stores/telemetry")
          .then(({ useTelemetryStore }) => {
            useTelemetryStore.getState().loadFeedbacks(storeActiveSessionId);
          })
          .catch(() => {
            /* telemetry not available */
          });
      }
    }, [storeActiveSessionId]);

    // Scroll to bottom after session messages are loaded
    const prevLoadingRef = React.useRef(isLoading);
    React.useEffect(() => {
      const wasLoading = prevLoadingRef.current;
      prevLoadingRef.current = isLoading;

      const shouldReveal =
        (wasLoading && !isLoading && needsScrollAfterLoadRef.current) ||
        (!isLoading && needsScrollAfterLoadRef.current);

      if (shouldReveal) {
        needsScrollAfterLoadRef.current = false;
        enableAutoFollow();
        scrollToBottom();
      }
    }, [isLoading, messages.length, enableAutoFollow, scrollToBottom]);

    const hasInitialScrolled = React.useRef(false);
    React.useEffect(() => {
      if (
        !hasInitialScrolled.current &&
        messages.length > 0 &&
        !isLoading
      ) {
        hasInitialScrolled.current = true;
        enableAutoFollow();
        scrollToBottom();
      }
    }, [messages.length, isLoading, enableAutoFollow, scrollToBottom]);

    const scrollRafRef = React.useRef<number | undefined>(undefined);
    React.useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;

      const handleScroll = () => {
        const atBottom = onScroll();

        if (scrollRafRef.current != null)
          cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = requestAnimationFrame(() => {
          setShowScrollButton(!atBottom && messages.length > 0);
          scrollRafRef.current = undefined;
        });
      };

      el.addEventListener("scroll", handleScroll, { passive: true });
      return () => {
        el.removeEventListener("scroll", handleScroll);
        if (scrollRafRef.current != null)
          cancelAnimationFrame(scrollRafRef.current);
      };
    }, [messages.length, activeSessionId, onScroll]);

    const handleScrollToBottom = () => {
      enableAutoFollow();
      scrollToBottom();
    };

    // Session-list fetch sets isLoading globally. On the welcome screen
    // (no active session) that must not replace emptyState with a spinner —
    // otherwise extension welcome flashes: ready → spinner → ready.
    const showSessionLoadingSpinner =
      Boolean(activeSessionId) && isLoading && messages.length === 0;

    const showCenteredEmpty =
      messages.length === 0 && !showSessionLoadingSpinner && emptyState !== null;

    // ── Render ───────────────────────────────────────────────────────────

    return (
      <>
        {/* ─── Conversation Area ───────────────────────────────────────── */}
        <div
          ref={scrollRef}
          data-chat-messages
          data-testid="v2-message-list"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
        >
          <div
            ref={messageAreaRef}
            className={cn(
              "w-full",
              compact ? "px-2 py-4" : "mx-auto px-4 py-6 max-w-3xl",
              showCenteredEmpty &&
                "flex flex-1 flex-col justify-center",
            )}
            style={{
              paddingBottom: externalComposer
                ? "12px"
                : `${inputAreaHeight + SAFE_BOTTOM_SPACING}px`,
            }}
          >
            {showSessionLoadingSpinner ? (
              <div
                className={cn(
                  "flex items-center justify-center",
                  compact ? "py-8" : "py-20",
                )}
                data-testid="message-list-session-loading"
              >
                <Loader2
                  className={cn(
                    "animate-spin text-muted-foreground",
                    compact ? "h-5 w-5" : "h-6 w-6",
                  )}
                />
              </div>
            ) : messages.length === 0 ? (
              emptyState === null ? null : (
              <div className={cn("w-full", !compact && "mx-auto max-w-xl")}>
              {emptyState ?? (
                <div
                  className={cn(
                    "flex flex-col items-center justify-center text-center",
                    compact ? "py-8 px-2" : "py-20",
                  )}
                >
                  <h2
                    className={cn(
                      "mb-1 font-semibold",
                      compact ? "text-sm" : "text-xl",
                    )}
                  >
                    {compact
                      ? t("chat.agent", "Agent")
                      : t("chat.startNewChat", "Start a New Chat")}
                  </h2>
                  <p
                    className={cn(
                      "text-muted-foreground",
                      compact ? "text-xs mb-2" : "text-sm mb-6",
                    )}
                  >
                    {compact
                      ? t("chat.askAboutFile", "Ask questions about the file")
                      : t("chat.askAnything", "Ask me anything")}
                  </p>
                </div>
              )}
              </div>
              )
            ) : (
              <div className="space-y-1">
                {hiddenMessageCount > 0 && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      onClick={() =>
                        setVisibleMessageCount((count) =>
                          Math.min(messages.length, count + LOAD_EARLIER_MESSAGE_COUNT),
                        )
                      }
                    >
                      {loadEarlierLabel}
                    </button>
                  </div>
                )}
                {/* Find the last completed assistant message for star rating */}
                {(() => {
                  // Star rating only on the last non-streaming assistant message with tokens
                  let lastCompletedAssistantIdx = -1;
                  for (let i = renderedMessages.length - 1; i >= 0; i--) {
                    const m = renderedMessages[i];
                    if (m.role !== "user" && !m.isStreaming && m.tokens) {
                      lastCompletedAssistantIdx = i;
                      break;
                    }
                  }

                  return useVirtualMessages ? (
                    <div
                      style={{
                        height: `${messageVirtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {messageVirtualizer
                        .getVirtualItems()
                        .map((virtualItem) => {
                          const message = renderedMessages[virtualItem.index];
                          const isLastMessage =
                            virtualItem.index === renderedMessages.length - 1;
                          const shouldShowThinking =
                            isLastMessage && message.isStreaming;
                          const allowStartThread = canStartThreadFromNewestIndex(
                            renderedMessages.length - 1 - virtualItem.index,
                          );

                          return (
                            <div
                              key={message.id}
                              ref={(el) => {
                                if (el) messageVirtualizer.measureElement(el);
                              }}
                              data-index={virtualItem.index}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualItem.start}px)`,
                              }}
                            >
                              <ErrorBoundary scope="Message" inline>
                                <ChatMessage
                                  message={message}
                                  activeSessionId={activeSessionId}
                                  basePath={activeSessionDirectory}
                                  shouldShowThinking={shouldShowThinking}
                                  showStarRating={
                                    virtualItem.index ===
                                    lastCompletedAssistantIdx
                                  }
                                  tokenGroupInfo={tokenGroupInfo.get(
                                    message.id,
                                  )}
                                  replyToMessage={
                                    message.replyToMessageId
                                      ? messagesById.get(message.replyToMessageId) ?? null
                                      : null
                                  }
                                  suppressThreadBadge={suppressThreadBadge}
                                  allowStartThread={allowStartThread}
                                />
                              </ErrorBoundary>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    renderedMessages.map((message, index) => {
                      const isLastMessage = index === renderedMessages.length - 1;
                      const shouldShowThinking =
                        isLastMessage && message.isStreaming;
                      const allowStartThread = canStartThreadFromNewestIndex(
                        renderedMessages.length - 1 - index,
                      );

                      return (
                        <div
                          key={message.id}
                          data-message-id={message.id}
                        >
                          <ErrorBoundary scope="Message" inline>
                            <ChatMessage
                              message={message}
                              activeSessionId={activeSessionId}
                              basePath={activeSessionDirectory}
                              shouldShowThinking={shouldShowThinking}
                              showStarRating={
                                index === lastCompletedAssistantIdx
                              }
                              tokenGroupInfo={tokenGroupInfo.get(message.id)}
                              replyToMessage={
                                message.replyToMessageId
                                  ? messagesById.get(message.replyToMessageId) ?? null
                                  : null
                              }
                              suppressThreadBadge={suppressThreadBadge}
                              allowStartThread={allowStartThread}
                            />
                          </ErrorBoundary>
                        </div>
                      );
                    })
                  );
                })()}
              </div>
            )}

            {bottomContent && (
              <div className="pt-3">
                {bottomContent}
              </div>
            )}
          </div>
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <div className="pointer-events-none absolute bottom-32 right-6 z-20">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="pointer-events-auto h-8 w-8 rounded-full shadow-md"
              onClick={handleScrollToBottom}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </>
    );
  },
);

/** Memoized so ChatPanel re-renders (e.g. streaming revision) that keep the
 *  same message props do not rebuild the whole thread tree. Composer draft is
 *  owned by ChatInputArea and never flows through these props. */
export const MessageList = React.memo(MessageListInner);
