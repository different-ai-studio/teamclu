import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { Message } from "@/stores/session-types";

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

globalThis.IntersectionObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

type VirtualizerOptions = {
  count: number;
  getItemKey?: (index: number) => string | number;
  anchorTo?: string;
  followOnAppend?: string | boolean;
  scrollEndThreshold?: number;
};

const capturedOptions: VirtualizerOptions[] = [];
const { scrollToEndMock, scrollToIndexMock, isAtEndMock, measureMock } =
  vi.hoisted(() => ({
    scrollToEndMock: vi.fn(),
    scrollToIndexMock: vi.fn(),
    isAtEndMock: vi.fn(() => true),
    measureMock: vi.fn(),
  }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: VirtualizerOptions) => {
    capturedOptions.push(options);
    const count = options.count;
    const items = Array.from({ length: Math.min(count, 3) }, (_, index) => ({
      index,
      key: options.getItemKey?.(index) ?? index,
      start: index * 154,
      size: 150,
    }));
    return {
      getTotalSize: () => count * 154,
      getVirtualItems: () => items,
      measureElement: vi.fn(),
      measure: measureMock,
      scrollToIndex: scrollToIndexMock,
      scrollToOffset: vi.fn(),
      scrollToEnd: scrollToEndMock,
      isAtEnd: isAtEndMock,
      itemSizeCache: new Map<string | number, number>(),
      containerRef: vi.fn(),
    };
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useSessionStore } from "@/stores/session-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { MessageList, VIRTUAL_SCROLL_END_THRESHOLD } from "../MessageList";
import {
  LOAD_EARLIER_HOLD_MS,
  LOAD_EARLIER_TOP_DEBOUNCE_MS,
} from "../message-list-load-earlier";

function makeMessage(index: number): Message {
  return {
    id: `msg-${String(index).padStart(3, "0")}`,
    sessionId: "sess-1",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`,
    parts: [],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(2024, 0, 1, 0, index),
  };
}

function buildMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => makeMessage(i + 1));
}

function latestVirtualizerOptions(): VirtualizerOptions {
  const opts = capturedOptions.at(-1);
  if (!opts?.getItemKey) {
    throw new Error("useVirtualizer was not configured with getItemKey");
  }
  return opts;
}

describe("MessageList virtualizer identity", () => {
  beforeEach(() => {
    capturedOptions.length = 0;
    scrollToEndMock.mockClear();
    scrollToIndexMock.mockClear();
    measureMock.mockClear();
    isAtEndMock.mockClear();
    isAtEndMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    useSessionListStore.setState({ loading: false });
    useSessionStore.setState({
      isLoading: false,
      messageQueue: [],
      activeSessionId: "sess-1",
      sessions: [],
    });
    useV2StreamingStore.setState({ byKey: {}, archived: [] });
  });

  it("passes getItemKey to useVirtualizer and keeps penultimate key on append", () => {
    const messages92 = buildMessages(92);
    const { rerender } = render(
      <MessageList
        messages={messages92}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const opts92 = latestVirtualizerOptions();
    expect(opts92.count).toBe(80);
    const msg92KeyBeforeAppend = opts92.getItemKey!(79);
    expect(msg92KeyBeforeAppend).toBe("sess-1:msg-092");

    const messages93 = [...messages92, makeMessage(93)];
    rerender(
      <MessageList
        messages={messages93}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const opts93 = latestVirtualizerOptions();
    expect(opts93.getItemKey!(78)).toBe(msg92KeyBeforeAppend);
    expect(opts93.getItemKey!(79)).toBe("sess-1:msg-093");
  });

  it("delegates bottom-following to the virtualizer instead of hand-rolled pinning", () => {
    render(
      <MessageList
        messages={buildMessages(92)}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const opts = latestVirtualizerOptions();
    expect(opts.anchorTo).toBe("end");
    expect(opts.followOnAppend).toBe("auto");
    expect(opts.scrollEndThreshold).toBe(VIRTUAL_SCROLL_END_THRESHOLD);
  });

  it("pins to the end when opening or returning to a long thread", async () => {
    const messages = buildMessages(92);
    const { rerender } = render(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    await waitFor(() => {
      expect(scrollToEndMock).toHaveBeenCalled();
    });

    rerender(
      <MessageList
        messages={buildMessages(40)}
        activeSessionId="sess-2"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );
    scrollToEndMock.mockClear();

    rerender(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    await waitFor(() => {
      expect(scrollToEndMock).toHaveBeenCalled();
    });
  });

  it("never re-measures or re-pins from the scroll handler", () => {
    const messages92 = buildMessages(92);
    const { rerender } = render(
      <MessageList
        messages={messages92}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const messages140 = buildMessages(140);
    rerender(
      <MessageList
        messages={messages140}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    // The user has scrolled up into history.
    isAtEndMock.mockReturnValue(false);
    scrollToEndMock.mockClear();
    measureMock.mockClear();

    const scrollEl = document.querySelector(
      '[data-testid="v2-message-list"]',
    ) as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollTop", {
      value: 4000,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "scrollHeight", {
      value: 12000,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 600,
      writable: true,
      configurable: true,
    });

    vi.useFakeTimers();
    scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();

    // measure() wipes the size cache; calling it from the scroll path makes the
    // total size flip between estimated and measured sums, which oscillates.
    expect(measureMock).not.toHaveBeenCalled();
    expect(scrollToEndMock).not.toHaveBeenCalled();
  });

  it("never scrolls anywhere on a load-earlier prepend", () => {
    render(
      <MessageList
        messages={buildMessages(140)}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const scrollEl = document.querySelector(
      '[data-testid="v2-message-list"]',
    ) as HTMLDivElement;
    for (const [prop, value] of [
      ["scrollTop", 0],
      ["scrollHeight", 12000],
      ["clientHeight", 600],
    ] as const) {
      Object.defineProperty(scrollEl, prop, {
        value,
        writable: true,
        configurable: true,
      });
    }

    const countBefore = latestVirtualizerOptions().count;
    scrollToIndexMock.mockClear();
    scrollToEndMock.mockClear();

    vi.useFakeTimers();
    scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    act(() => {
      vi.advanceTimersByTime(LOAD_EARLIER_TOP_DEBOUNCE_MS + 50);
    });
    // The spinner holds the top on its own before the batch arrives.
    expect(latestVirtualizerOptions().count).toBe(countBefore);
    act(() => {
      vi.advanceTimersByTime(LOAD_EARLIER_HOLD_MS + 50);
    });
    vi.useRealTimers();

    // Older messages arrive above and the reader's place is held by correcting
    // the offset. Taking them anywhere — to the anchor row or to the end — is a
    // jump they did not ask for.
    expect(latestVirtualizerOptions().count).toBeGreaterThan(countBefore);
    expect(scrollToIndexMock).not.toHaveBeenCalled();
    expect(scrollToEndMock).not.toHaveBeenCalled();
  });

  it("uses virtualItem.key on rendered virtual rows", () => {
    const messages = buildMessages(92);
    const { container } = render(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    const opts = latestVirtualizerOptions();
    const expectedKey = String(opts.getItemKey!(0));
    const row = container.querySelector(`[data-message-id="msg-013"]`);
    expect(row).toBeTruthy();
    expect(container.textContent).toContain("Message 13");
    expect(expectedKey).toBe("sess-1:msg-013");
  });
});
