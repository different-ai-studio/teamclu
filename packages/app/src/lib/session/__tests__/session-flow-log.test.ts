import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from "@/lib/session/session-flow-log";

describe("session-flow-log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes structured stage logs with a stable prefix", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    sessionFlowLog("send.optimistic_append", {
      sessionId: "session-1",
      messageId: "message-1",
    });

    expect(spy).toHaveBeenCalledWith(
      "[session-flow] send.optimistic_append",
      expect.objectContaining({
        stage: "send.optimistic_append",
        sessionId: "session-1",
        messageId: "message-1",
      }),
    );
  });

  it("summarizes message text without logging the whole body", () => {
    expect(summarizeText("  hello world  ", 5)).toEqual({
      textLength: 11,
      textPreview: "hello...",
    });
  });

  it("serializes errors into log payloads", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    sessionFlowError("outbox.insert_failed", new Error("boom"), {
      messageId: "message-1",
    });

    expect(spy).toHaveBeenCalledWith(
      "[session-flow] outbox.insert_failed",
      expect.objectContaining({
        stage: "outbox.insert_failed",
        messageId: "message-1",
        error: expect.objectContaining({
          name: "Error",
          message: "boom",
        }),
      }),
    );
  });
});
