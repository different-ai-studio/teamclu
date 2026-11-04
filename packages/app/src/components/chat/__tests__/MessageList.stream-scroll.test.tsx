import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import {
  flushPendingSessionRevisionsForTests,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import type { Message } from "@/stores/session-types";

const scrollToBottomIfAtBottom = vi.fn();
vi.mock("@/hooks/use-chat-stick-to-bottom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-chat-stick-to-bottom")>();
  return {
    ...actual,
    useChatStickToBottom: (...args: Parameters<typeof actual.useChatStickToBottom>) => ({
      ...actual.useChatStickToBottom(...args),
      scrollToBottomIfAtBottom,
    }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { MessageList } from "../MessageList";

const SID = "sess-1";

function message(id: string): Message {
  return {
    id,
    sessionId: SID,
    role: "user",
    content: `hello ${id}`,
    parts: [],
    timestamp: new Date(1_700_000_000_000),
  } as unknown as Message;
}

function delta(text: string) {
  act(() => {
    useV2StreamingStore.getState().appendOutput(SID, "agent-1", text);
    flushPendingSessionRevisionsForTests();
  });
}

describe("MessageList while a reply streams", () => {
  beforeEach(() => {
    scrollToBottomIfAtBottom.mockClear();
    act(() => {
      useV2StreamingStore.getState().clearSession(SID);
      flushPendingSessionRevisionsForTests();
    });
  });

  // The list draws nothing from the stream — live text is in the composer
  // dock — but it subscribed to the session revision in render to drive
  // stick-to-bottom, re-rendering the whole list on every frame of a reply.
  it("keeps following the bottom without re-rendering on each delta", () => {
    let renders = 0;
    render(
      <React.Profiler id="list" onRender={() => { renders += 1; }}>
        <MessageList
          messages={[message("m1"), message("m2")]}
          activeSessionId={SID}
          isStreaming
          streamingMessageId={null}
        />
      </React.Profiler>,
    );
    const rendersBefore = renders;
    const scrollsBefore = scrollToBottomIfAtBottom.mock.calls.length;

    for (let i = 0; i < 20; i++) delta(` chunk ${i}`);

    expect(renders).toBe(rendersBefore);
    expect(scrollToBottomIfAtBottom.mock.calls.length - scrollsBefore).toBe(20);
  });
});
