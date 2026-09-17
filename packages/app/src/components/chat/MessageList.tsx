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
import {
  expandVisibleMessageCount,
  isScrollAtTop,
  LOAD_EARLIER_HOLD_MS,
  LOAD_EARLIER_TOP_DEBOUNCE_MS,
} from "./message-list-load-earlier";

export { LOAD_EARLIER_MESSAGE_COUNT } from "./message-list-load-earlier";

// ─── Constants ────────────────────────────────────────────────────────────────

// Virtualize long threads (>80 messages). Matches INITIAL_VISIBLE_MESSAGE_COUNT
// so the windowed "load earlier" path and the virtualizer engage together.
// Dynamic heights via measureElement + messageAreaWidth remeasure; smoke-test
// open a >80-message session, toggle sidebar / resize, confirm no row overlap.
export const VIRTUAL_MSG_THRESHOLD = 80;
/** Extra rows kept mounted above/below the viewport — reduces markdown remount jank. */
export const VIRTUAL_MSG_OVERSCAN = 24;
/**
 * How close to the end still counts as "at the end" for the virtualizer's own
 * `followOnAppend` / size-change anchoring. Deliberately tight: the container's
 * paddingBottom (composer height + safe spacing) already grants slack on top of
 * this, and a loose value is what drags a reader back down.
 */
export const VIRTUAL_SCROLL_END_THRESHOLD = 24;
const INITIAL_VISIBLE_MESSAGE_COUNT = 80;
const DEFAULT_VIRTUAL_ROW_ESTIMATE = 150;
/** Cap on remembered row heights so a long-lived window does not grow forever. */
const REMEMBERED_ROW_HEIGHT_LIMIT = 4000;
const VIRTUAL_ROW_GAP = 4;

/** Where a message row sits relative to the top edge of the scroll viewport. */
function readRowViewportTop(
  scrollEl: HTMLElement,
  messageId: string,
): number | null {
  const row = scrollEl.querySelector(`[data-message-id="${messageId}"]`);
  if (!row) return null;
  return (
    row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top
  );
}

/** Stable TanStack Virtual row identity — not array index (window slides on append). */
export function getVirtualMessageKey(
  messages: readonly Message[],
  index: number,
): string | number {
  const message = messages[index];
  if (!message) return index;
  const sessionId = message.sessionId ?? "";
  return sessionId ? `${sessionId}:${message.id}` : message.id;
}

/**
 * Heuristic row height before measureElement — closer estimates reduce scroll-up
 * blank gaps.
 *
 * Nothing here may be clamped. Message bodies are not truncated in the UI, so a
 * single long agent reply genuinely is ten thousand pixels tall; capping its
 * estimate puts every row after it off by that difference, which is a viewport
 * with nothing in it and an anchor restore that cannot land. Height has to track
 * content for as far as content goes.
 */
export function estimateVirtualMessageSize(message: Message): number {
  if (
    message.displayKind === "compaction" ||
    message.displayKind === "compaction-summary"
  ) {
    return 40;
  }
  if (message.displayKind === "synthetic") {
    return 32;
  }

  const toolCallCount = message.toolCalls?.length ?? 0;
  const contentLen =
    message.content?.length ??
    message.parts.reduce(
      (total, part) =>
        total + (part.text?.length ?? part.content?.length ?? 0),
      0,
    );

  if (message.role === "user") {
    const lineEstimate = Math.ceil(contentLen / 42);
    return Math.max(64, 48 + lineEstimate * 24);
  }

  let height = 72 + toolCallCount * 52;
  if (contentLen > 0) {
    // Erring high is the safe direction: an overestimate leaves a gap that
    // measurement closes, an underestimate leaves viewport with nothing in it.
    // 0.42px/char matches 13.5px/1.7 body text in a ~700px pane plus the block
    // spacing markdown adds on top of raw characters.
    height += Math.max(96, Math.round(contentLen * 0.42));
  } else if ((message.parts?.length ?? 0) > 0) {
    height += 120;
  }
  return height;
}

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
    const [loadingEarlier, setLoadingEarlier] = React.useState(false);
    const loadEarlierInFlightRef = React.useRef(false);
    const loadEarlierHoldTimerRef = React.useRef<number | null>(null);
    const loadEarlierDebounceTimerRef = React.useRef<number | null>(null);
    const loadEarlierPendingRef = React.useRef(false);
    const loadEarlierAnchorRef = React.useRef<{
      messageId: string;
      viewportTop: number;
    } | null>(null);
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
        const isAssistant =
          msg &&
          msg.role !== "user" &&
          !msg.hidden &&
          msg.displayKind !== "compaction" &&
          msg.displayKind !== "compaction-summary" &&
          msg.displayKind !== "synthetic";
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
    const hasInitialScrolled = React.useRef(false);

    const {
      scrollToBottom,
      scrollToBottomIfAtBottom,
      scrollToBottomAfterCommit,
      observeContentResize,
      onScroll,
      enableAutoFollow,
      pauseAutoFollowIfReading,
      stopAutoFollow,
      isFollowingBottom,
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

    const getVirtualItemKey = React.useCallback(
      (index: number) => getVirtualMessageKey(renderedMessages, index),
      [renderedMessages],
    );

    /**
     * Real heights of rows we have already rendered, keyed the same way the
     * virtualizer keys them and kept across unmount.
     *
     * The virtualizer deliberately skips measuring while a scroll is in flight
     * (`measureElement` no-ops when `isScrolling`), so during a fast fling every
     * freshly mounted row is placed at whatever `estimateSize` guesses. A guess
     * from content length is off by hundreds of px, and that geometry error is
     * what shows up as an empty viewport until a nudge re-measures. A row that
     * has been on screen once needs no guess.
     */
    // Key type mirrors the virtualizer's own `Key` (it is not re-exported).
    const measuredRowHeightsRef = React.useRef(
      new Map<number | string | bigint, number>(),
    );

    const estimateVirtualRowSize = React.useCallback(
      (index: number) => {
        const message = renderedMessages[index];
        if (!message) return DEFAULT_VIRTUAL_ROW_ESTIMATE;
        const remembered = measuredRowHeightsRef.current.get(
          getVirtualMessageKey(renderedMessages, index),
        );
        return remembered ?? estimateVirtualMessageSize(message);
      },
      [renderedMessages],
    );

    // anchorTo/followOnAppend put bottom-pinning inside the virtualizer: row
    // growth while at the end scrolls by the exact delta, and prepending older
    // rows restores the anchor row's offset. Nothing outside may write scrollTop
    // in virtual mode — two writers on one scroll position oscillate.
    const messageVirtualizer = useVirtualizer({
      count: useVirtualMessages ? renderedMessages.length : 0,
      getScrollElement: () => scrollRef.current,
      estimateSize: estimateVirtualRowSize,
      getItemKey: getVirtualItemKey,
      overscan: VIRTUAL_MSG_OVERSCAN,
      gap: VIRTUAL_ROW_GAP,
      useAnimationFrameWithResizeObserver: true,
      anchorTo: "end",
      followOnAppend: "auto",
      scrollEndThreshold: VIRTUAL_SCROLL_END_THRESHOLD,
    });

    // Runs after every commit: whatever the virtualizer measured this pass is
    // now the estimate for the next time that row mounts.
    React.useEffect(() => {
      if (!useVirtualMessages) return;
      const remembered = measuredRowHeightsRef.current;
      for (const [key, size] of messageVirtualizer.itemSizeCache) {
        if (size > 0) remembered.set(key, size);
      }
      // Insertion order is oldest-first, so trimming the front drops the rows
      // least likely to be scrolled back to.
      if (remembered.size > REMEMBERED_ROW_HEIGHT_LIMIT) {
        for (const key of remembered.keys()) {
          if (remembered.size <= REMEMBERED_ROW_HEIGHT_LIMIT) break;
          remembered.delete(key);
        }
      }
    });

    const pinVirtualEndIndex = React.useCallback(() => {
      if (!useVirtualMessages || renderedMessages.length === 0) return;
      messageVirtualizer.scrollToEnd();
    }, [messageVirtualizer, renderedMessages.length, useVirtualMessages]);

    /** True when the viewport is parked at the newest row and may follow growth. */
    const isViewportAtBottom = React.useCallback(() => {
      if (useVirtualMessages) {
        return messageVirtualizer.isAtEnd();
      }
      return isFollowingBottom();
    }, [isFollowingBottom, messageVirtualizer, useVirtualMessages]);

    /**
     * Re-pin after something outside the virtualizer changed the scrollable
     * height (composer chrome, container width). Row growth and appends are the
     * virtualizer's job — do not call this from streaming or message effects.
     */
    const repinBottomIfAtBottom = React.useCallback(() => {
      if (!isViewportAtBottom()) return;
      if (useVirtualMessages) {
        pinVirtualEndIndex();
        return;
      }
      scrollToBottomIfAtBottom();
    }, [
      isViewportAtBottom,
      pinVirtualEndIndex,
      scrollToBottomIfAtBottom,
      useVirtualMessages,
    ]);

    /** One-shot bottom pin when opening a session — one mechanism per list mode. */
    const revealThreadAtBottom = React.useCallback(() => {
      enableAutoFollow();
      if (useVirtualMessages && renderedMessages.length > 0) {
        requestAnimationFrame(() => {
          pinVirtualEndIndex();
        });
        return;
      }
      scrollToBottomAfterCommit();
    }, [
      enableAutoFollow,
      pinVirtualEndIndex,
      renderedMessages.length,
      scrollToBottomAfterCommit,
      useVirtualMessages,
    ]);

    const scrollToLatestMessage = React.useCallback(
      (_messageId?: string) => {
        revealThreadAtBottom();
      },
      [revealThreadAtBottom],
    );

    const handleInputHeightChange = React.useCallback(
      (height: number) => {
        const wasAtBottom = isViewportAtBottom();
        setInputAreaHeight((prev) => (prev === height ? prev : height));
        if (!wasAtBottom) return;
        requestAnimationFrame(() => {
          repinBottomIfAtBottom();
        });
      },
      [isViewportAtBottom, repinBottomIfAtBottom],
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
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = 0;
      }
      hasInitialScrolled.current = false;
      loadEarlierInFlightRef.current = false;
      loadEarlierPendingRef.current = false;
      loadEarlierAnchorRef.current = null;
      setLoadingEarlier(false);
      if (loadEarlierDebounceTimerRef.current != null) {
        window.clearTimeout(loadEarlierDebounceTimerRef.current);
        loadEarlierDebounceTimerRef.current = null;
      }
      if (loadEarlierHoldTimerRef.current != null) {
        window.clearTimeout(loadEarlierHoldTimerRef.current);
        loadEarlierHoldTimerRef.current = null;
      }
    }, [activeSessionId]);

    // Width drives wrapping, so every row estimate is stale — this is the one
    // legitimate `measure()`: it clears the size cache so rows re-report.
    React.useLayoutEffect(() => {
      if (!useVirtualMessages || messageAreaWidth <= 0) return;

      const raf = requestAnimationFrame(() => {
        const wasAtBottom = messageVirtualizer.isAtEnd();
        // Remembered heights were measured at the previous width — at a new one
        // they are wrong in the same way the heuristic is.
        measuredRowHeightsRef.current.clear();
        messageVirtualizer.measure();
        if (wasAtBottom) {
          messageVirtualizer.scrollToEnd();
        }
      });

      return () => cancelAnimationFrame(raf);
    }, [useVirtualMessages, messageAreaWidth, messageVirtualizer]);

    // The messages are on screen by the time this runs, so the spinner leaves
    // now. Holding it any longer past the content is the other half of looking
    // fake.
    const finishLoadEarlierBatch = React.useCallback(() => {
      loadEarlierInFlightRef.current = false;
      setLoadingEarlier(false);
    }, []);

    const requestLoadEarlierMessages = React.useCallback(() => {
      if (loadEarlierInFlightRef.current || hiddenMessageCount <= 0) {
        return;
      }

      const scrollEl = scrollRef.current;
      if (!scrollEl || !isScrollAtTop(scrollEl.scrollTop)) {
        return;
      }

      const previousVisible = visibleMessageCount;
      const nextVisible = expandVisibleMessageCount(
        previousVisible,
        messages.length,
      );
      if (nextVisible === previousVisible) {
        return;
      }

      loadEarlierInFlightRef.current = true;
      setLoadingEarlier(true);
      stopAutoFollow();

      // The spinner gets this commit to itself, and the list stays at the top
      // for the hold. Prepending in the same batch is what made it read as
      // fake: the messages it claims to be fetching were already on screen the
      // moment it appeared.
      loadEarlierHoldTimerRef.current = window.setTimeout(() => {
        loadEarlierHoldTimerRef.current = null;

        // Read the anchor now rather than at request time — the reader may have
        // moved during the hold, and the correction has to undo this prepend
        // from wherever they actually are.
        const el = scrollRef.current;
        const anchorId = renderedMessages[0]?.id ?? null;
        const anchorTop =
          el && anchorId ? readRowViewportTop(el, anchorId) : null;
        loadEarlierAnchorRef.current =
          anchorId && anchorTop !== null
            ? { messageId: anchorId, viewportTop: anchorTop }
            : null;

        loadEarlierPendingRef.current = true;
        setVisibleMessageCount(nextVisible);
      }, LOAD_EARLIER_HOLD_MS);
    }, [
      hiddenMessageCount,
      messages.length,
      renderedMessages,
      stopAutoFollow,
      visibleMessageCount,
    ]);

    /**
     * Hold the reader's place across the prepend. Older messages land above;
     * nothing jumps and nothing is scrolled to. Reaching them is the reader's
     * job.
     *
     * The correction is a difference of two DOM readings of the same row, taken
     * before and after the batch, so it is exact no matter how far off the
     * estimates for the newly prepended rows are — and both `anchorTo: "end"`
     * and any offset we could compute ourselves are only as good as those
     * estimates. Running before paint means the row never visibly moves.
     */
    React.useLayoutEffect(() => {
      if (!loadEarlierPendingRef.current) return;
      loadEarlierPendingRef.current = false;

      const anchor = loadEarlierAnchorRef.current;
      loadEarlierAnchorRef.current = null;
      const scrollEl = scrollRef.current;

      if (anchor && scrollEl) {
        const nextTop = readRowViewportTop(scrollEl, anchor.messageId);
        if (nextTop !== null) {
          const drift = nextTop - anchor.viewportTop;
          if (Math.abs(drift) > 0.5) {
            const target = scrollEl.scrollTop + drift;
            // Going through the virtualizer keeps its own scroll offset in step
            // with the DOM. A bare scrollTop write leaves the two disagreeing
            // until the next scroll event, and the range it renders in between
            // is the one for the old position.
            if (useVirtualMessages) {
              messageVirtualizer.scrollToOffset(target);
            } else {
              scrollEl.scrollTop = target;
            }
          }
        }
      }

      finishLoadEarlierBatch();
    }, [
      visibleMessageCount,
      finishLoadEarlierBatch,
      messageVirtualizer,
      useVirtualMessages,
    ]);

    const scheduleLoadEarlierAtTop = React.useCallback(() => {
      if (
        loadEarlierInFlightRef.current ||
        hiddenMessageCount <= 0 ||
        loadEarlierDebounceTimerRef.current != null
      ) {
        return;
      }

      loadEarlierDebounceTimerRef.current = window.setTimeout(() => {
        loadEarlierDebounceTimerRef.current = null;
        const scrollEl = scrollRef.current;
        if (
          scrollEl &&
          isScrollAtTop(scrollEl.scrollTop) &&
          !loadEarlierInFlightRef.current
        ) {
          requestLoadEarlierMessages();
        }
      }, LOAD_EARLIER_TOP_DEBOUNCE_MS);
    }, [hiddenMessageCount, requestLoadEarlierMessages]);

    const cancelLoadEarlierDebounce = React.useCallback(() => {
      if (loadEarlierDebounceTimerRef.current != null) {
        window.clearTimeout(loadEarlierDebounceTimerRef.current);
        loadEarlierDebounceTimerRef.current = null;
      }
    }, []);

    React.useEffect(
      () => () => {
        cancelLoadEarlierDebounce();
        if (loadEarlierHoldTimerRef.current != null) {
          window.clearTimeout(loadEarlierHoldTimerRef.current);
          loadEarlierHoldTimerRef.current = null;
        }
      },
      [cancelLoadEarlierDebounce],
    );

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
    React.useEffect(() => {
      if (useVirtualMessages) return;
      return observeContentResize(messageAreaRef);
    }, [observeContentResize, activeSessionId, useVirtualMessages]);

    // Non-virtual only. In virtual mode row growth is handled by `anchorTo:
    // "end"`, which scrolls by the exact size delta and only while at the end.
    React.useEffect(() => {
      const wasStreaming = prevStreamingRef.current;
      prevStreamingRef.current = isStreaming;
      if (useVirtualMessages) return;
      if (isStreaming && !wasStreaming) {
        scrollToBottomIfAtBottom();
      }
    }, [isStreaming, scrollToBottomIfAtBottom, useVirtualMessages]);

    React.useEffect(() => {
      if (useVirtualMessages) return;
      if (v2StreamScrollTrigger > 0) {
        scrollToBottomIfAtBottom();
      }
    }, [v2StreamScrollTrigger, scrollToBottomIfAtBottom, useVirtualMessages]);

    // Non-virtual only. In virtual mode appends are handled by `followOnAppend`,
    // which follows the new tail only when the viewport was already at the end.
    React.useEffect(() => {
      if (useVirtualMessages) return;
      const grew = messages.length > prevMessageCountRef.current;
      prevMessageCountRef.current = messages.length;
      if (grew) {
        scrollToBottomAfterCommit();
      }
    }, [messages.length, scrollToBottomAfterCommit, useVirtualMessages]);

    const prevMessageCountRef = React.useRef(messages.length);
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
        needsScrollAfterLoadRef.current &&
        !isLoading &&
        (wasLoading || messages.length > 0);

      if (shouldReveal) {
        needsScrollAfterLoadRef.current = false;
        hasInitialScrolled.current = true;
        revealThreadAtBottom();
      }
    }, [isLoading, messages.length, revealThreadAtBottom]);

    React.useEffect(() => {
      if (
        hasInitialScrolled.current ||
        messages.length === 0 ||
        isLoading ||
        needsScrollAfterLoadRef.current
      ) {
        return;
      }
      hasInitialScrolled.current = true;
      revealThreadAtBottom();
    }, [messages.length, isLoading, revealThreadAtBottom]);

    const scrollRafRef = React.useRef<number | undefined>(undefined);
    React.useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;

      const handleScroll = () => {
        // Virtual mode owns its own follow state — the handler only reads, so a
        // scroll the virtualizer itself performed cannot flip anything.
        const atBottom = useVirtualMessages
          ? messageVirtualizer.isAtEnd()
          : onScroll();

        if (isScrollAtTop(el.scrollTop) && hiddenMessageCount > 0) {
          scheduleLoadEarlierAtTop();
        } else {
          cancelLoadEarlierDebounce();
        }

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
    }, [
      messages.length,
      activeSessionId,
      onScroll,
      hiddenMessageCount,
      scheduleLoadEarlierAtTop,
      cancelLoadEarlierDebounce,
      useVirtualMessages,
      messageVirtualizer,
    ]);

    const handleScrollToBottom = () => {
      enableAutoFollow();
      if (useVirtualMessages && renderedMessages.length > 0) {
        pinVirtualEndIndex();
        return;
      }
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
                              key={virtualItem.key}
                              ref={(el) => {
                                if (el) messageVirtualizer.measureElement(el);
                              }}
                              data-index={virtualItem.index}
                              data-message-id={message.id}
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

        {/* Floated, never in the scrolled flow: an in-flow loading row changes
            the offset of every virtual item when it mounts or unmounts, which
            reads as the visible messages jumping. */}
        {(hiddenMessageCount > 0 || loadingEarlier) && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2"
            data-testid="load-earlier-sentinel"
            aria-busy={loadingEarlier}
          >
            {loadingEarlier ? (
              <div className="flex items-center gap-2 rounded-full border border-border bg-paper px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>
                  {t(
                    "chat.loadingEarlierMessages",
                    "Loading earlier messages…",
                  )}
                </span>
              </div>
            ) : null}
          </div>
        )}

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
