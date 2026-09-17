import { describe, expect, it } from "vitest";
import {
  expandVisibleMessageCount,
  LOAD_EARLIER_MESSAGE_COUNT,
} from "../message-list-load-earlier";
import { estimatePrependedScrollDelta } from "../MessageList";
import type { Message } from "@/stores/session-types";

function makeMessage(id: string, content: string, role: "user" | "assistant" = "user"): Message {
  return {
    id,
    sessionId: "sess-1",
    role,
    content,
    parts: [],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
  };
}

describe("expandVisibleMessageCount", () => {
  it("adds up to 60 messages per batch", () => {
    expect(expandVisibleMessageCount(80, 140)).toBe(80 + LOAD_EARLIER_MESSAGE_COUNT);
    expect(expandVisibleMessageCount(80, 200)).toBe(140);
  });

  it("does not expand when everything is visible", () => {
    expect(expandVisibleMessageCount(80, 80)).toBe(80);
  });

  it("loads a partial batch at the end of history", () => {
    expect(expandVisibleMessageCount(80, 95)).toBe(95);
  });
});

describe("estimatePrependedScrollDelta", () => {
  it("sums only the rows inserted above the previous window", () => {
    const messages = Array.from({ length: 140 }, (_, index) =>
      makeMessage(`m-${index}`, index % 2 === 0 ? "hi" : "x".repeat(500), index % 2 === 0 ? "user" : "assistant"),
    );

    const delta = estimatePrependedScrollDelta(messages, 80, 140);
    expect(delta).toBeGreaterThan(60 * 80);
  });
});
