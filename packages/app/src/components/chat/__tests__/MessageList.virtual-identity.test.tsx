import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Message } from "@/stores/session-types";

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

type VirtualizerOptions = {
  count: number;
  getItemKey?: (index: number) => string | number;
};

const capturedOptions: VirtualizerOptions[] = [];
const { scrollToIndexMock } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn(),
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
      measure: vi.fn(),
      scrollToIndex: scrollToIndexMock,
      scrollToOffset: vi.fn(),
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
import { MessageList } from "../MessageList";

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
    scrollToIndexMock.mockClear();
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

  it("pins to the last virtual row when opening or returning to a long thread", () => {
    vi.useFakeTimers();
    const messages = buildMessages(92);
    const { rerender } = render(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    expect(scrollToIndexMock).toHaveBeenCalledWith(
      79,
      expect.objectContaining({ align: "end" }),
    );

    rerender(
      <MessageList
        messages={buildMessages(40)}
        activeSessionId="sess-2"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );
    scrollToIndexMock.mockClear();

    rerender(
      <MessageList
        messages={messages}
        activeSessionId="sess-1"
        isStreaming={false}
        streamingMessageId={null}
      />,
    );

    expect(scrollToIndexMock).toHaveBeenCalledWith(
      79,
      expect.objectContaining({ align: "end" }),
    );

    vi.advanceTimersByTime(320);
    expect(scrollToIndexMock.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
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
