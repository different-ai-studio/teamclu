import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";

import { NEAR_BOTTOM_THRESHOLD } from "@/components/chat/layout-constants";
import { useChatStickToBottom } from "../use-chat-stick-to-bottom";

function mockScrollEl({
  scrollHeight = 1000,
  clientHeight = 400,
  scrollTop = 0,
}: {
  scrollHeight?: number;
  clientHeight?: number;
  scrollTop?: number;
} = {}) {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  el.scrollTo = vi.fn(({ top: nextTop }: { top: number }) => {
    top = nextTop;
  }) as unknown as typeof el.scrollTo;
  return el;
}

describe("useChatStickToBottom", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pauseAutoFollowIfReading clears follow when far from bottom", () => {
    const scrollRef = React.createRef<HTMLDivElement>();
    const el = mockScrollEl({
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 200,
    });
    scrollRef.current = el;

    const { result } = renderHook(() => useChatStickToBottom(scrollRef));

    act(() => {
      result.current.enableAutoFollow();
      result.current.pauseAutoFollowIfReading();
    });

    act(() => {
      result.current.scrollToBottomIfAtBottom();
    });

    expect(el.scrollTop).toBe(200);
  });

  it("scrollToBottomIfAtBottom still follows when near bottom", async () => {
    const scrollRef = React.createRef<HTMLDivElement>();
    const el = mockScrollEl({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 1000 - 400 - (NEAR_BOTTOM_THRESHOLD - 20),
    });
    scrollRef.current = el;

    const { result } = renderHook(() => useChatStickToBottom(scrollRef));

    act(() => {
      result.current.onScroll();
      result.current.scrollToBottomIfAtBottom();
    });

    // scrollContainerToBottom is now rAF-coalesced (one scroll per frame), so
    // the actual scroll lands on the next animation frame. Flush it before
    // asserting the deferred scroll position.
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });

    expect(el.scrollTop).toBe(600);
  });

  it("onScroll clears follow once the reader leaves the near-bottom zone", () => {
    const scrollRef = React.createRef<HTMLDivElement>();
    const el = mockScrollEl({
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 2000 - 400 - (NEAR_BOTTOM_THRESHOLD + 50),
    });
    scrollRef.current = el;

    const { result } = renderHook(() => useChatStickToBottom(scrollRef));

    act(() => {
      result.current.enableAutoFollow();
      expect(result.current.onScroll()).toBe(false);
    });

    act(() => {
      result.current.scrollToBottomIfAtBottom();
    });

    expect(el.scrollTop).toBe(2000 - 400 - (NEAR_BOTTOM_THRESHOLD + 50));
  });
});
