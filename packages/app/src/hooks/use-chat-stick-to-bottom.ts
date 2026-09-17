import * as React from "react";

import { NEAR_BOTTOM_THRESHOLD } from "@/components/chat/layout-constants";

/**
 * Stick-to-bottom for the chat thread — **short threads only**.
 *
 * Once the thread virtualizes (see VIRTUAL_MSG_THRESHOLD) bottom-pinning belongs
 * to the virtualizer's `anchorTo: "end"` / `followOnAppend`, and MessageList stops
 * driving follow state from here. Two writers on one scrollTop oscillate: the
 * virtualizer re-targets across frames as rows are measured, and every one of
 * those scrolls looks exactly like a user gesture from a scroll listener.
 *
 * Single source of truth: scroll to `scrollHeight - clientHeight` whenever we
 * want to be "at the bottom". The scroll container's content has a
 * `paddingBottom = inputAreaHeight + SAFE_BOTTOM_SPACING`, so scrolling to the
 * absolute bottom leaves the last real content just above the floating input.
 *
 * Rules:
 *   - On send:        force isAtBottom=true and scroll to bottom after React commits.
 *   - On content grow: if isAtBottom, scroll to bottom (ResizeObserver, grow-only).
 *   - On user scroll up: isAtBottom=false → stop auto-follow.
 *   - On reaching bottom: isAtBottom=true.
 *   - Composer chrome resize: only follow if already at bottom (never force-follow).
 *   - Composer focus while reading: pauseAutoFollowIfReading() clears follow.
 */
export function useChatStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  const isAtBottomRef = React.useRef(true);
  const scrollRafScheduledRef = React.useRef(false);

  const doScrollTo = React.useCallback((el: HTMLElement, top: number) => {
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top, behavior: "instant" });
    } else {
      el.scrollTop = top;
    }
  }, []);

  /**
   * Scroll the container to the absolute bottom, coalesced to at most one
   * scroll per animation frame. During streaming the ResizeObserver can fire
   * many times per frame; gating on rAF collapses those into a single scroll.
   * Falls back to synchronous scroll where rAF is unavailable.
   */
  const scrollContainerToBottom = React.useCallback(() => {
    const run = () => {
      const el = scrollRef.current;
      if (!el) return;
      doScrollTo(el, el.scrollHeight - el.clientHeight);
    };
    if (typeof requestAnimationFrame !== "function") {
      run();
      return;
    }
    if (scrollRafScheduledRef.current) return;
    scrollRafScheduledRef.current = true;
    requestAnimationFrame(() => {
      // Clear the gate before scrolling so the scroll callback itself never
      // leaves a stale "scheduled" flag (a synchronous rAF mock would run the
      // callback before any assignment of the returned id could complete).
      scrollRafScheduledRef.current = false;
      run();
    });
  }, [scrollRef, doScrollTo]);

  /** Scroll to absolute bottom unconditionally, and flag as at-bottom. */
  const scrollToBottom = React.useCallback(() => {
    isAtBottomRef.current = true;
    scrollContainerToBottom();
  }, [scrollContainerToBottom]);

  /**
   * Scroll to absolute bottom only if currently following.
   * Used in streaming effects as a fallback for environments where
   * ResizeObserver does not fire (e.g. JSDOM tests).
   */
  const scrollToBottomIfAtBottom = React.useCallback(() => {
    if (!isAtBottomRef.current) return;
    scrollContainerToBottom();
  }, [scrollContainerToBottom]);

  /**
   * Called from ChatPanel right after optimistic message append.
   * Force-follow + wait for React commit (2 rAFs) + scroll to absolute bottom.
   * The padding inside `messageArea` puts the new user message just above the
   * floating chat input overlay.
   */
  const scrollToBottomAfterCommit = React.useCallback(() => {
    isAtBottomRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollContainerToBottom();
      });
    });
  }, [scrollContainerToBottom]);

  /**
   * Observe the content area for size changes (new messages, streaming).
   * When isAtBottom is true, scroll to absolute bottom so the latest content
   * stays visible above the input overlay.
   */
  const observeContentResize = React.useCallback(
    (
      contentRef: React.RefObject<HTMLElement | null>,
    ): (() => void) | undefined => {
      const el = contentRef.current;
      if (!el) return;
      let lastHeight = el.getBoundingClientRect().height;
      const observer = new ResizeObserver(() => {
        if (!isAtBottomRef.current) return;
        const nextHeight = el.getBoundingClientRect().height;
        // Ignore shrink-only updates (loading slot collapse, etc.) while following.
        if (nextHeight <= lastHeight) {
          lastHeight = nextHeight;
          return;
        }
        lastHeight = nextHeight;
        scrollContainerToBottom();
      });
      observer.observe(el);
      return () => observer.disconnect();
    },
    [scrollContainerToBottom],
  );

  /** Stop auto-follow when the user is reading above the composer overlay. */
  const pauseAutoFollowIfReading = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist >= NEAR_BOTTOM_THRESHOLD) {
      isAtBottomRef.current = false;
    }
  }, [scrollRef]);

  /** Called from the scroll container's scroll handler. Returns atBottom. */
  const onScroll = React.useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < NEAR_BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    return atBottom;
  }, [scrollRef]);

  const enableAutoFollow = React.useCallback(() => {
    isAtBottomRef.current = true;
  }, []);

  const stopAutoFollow = React.useCallback(() => {
    isAtBottomRef.current = false;
  }, []);

  const isFollowingBottom = React.useCallback(() => isAtBottomRef.current, []);

  return {
    scrollToBottom,
    scrollToBottomIfAtBottom,
    scrollToBottomAfterCommit,
    observeContentResize,
    onScroll,
    enableAutoFollow,
    pauseAutoFollowIfReading,
    stopAutoFollow,
    isFollowingBottom,
  };
}
