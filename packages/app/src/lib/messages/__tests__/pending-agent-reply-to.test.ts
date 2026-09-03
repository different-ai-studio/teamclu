import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPendingAgentReplyToForTests,
  notePendingAgentReplyTo,
  peekPendingAgentReplyTo,
  removePendingAgentReplyTo,
  resolvePendingAgentReplyTo,
  takePendingAgentReplyTo,
} from "@/lib/messages/pending-agent-reply-to";

describe("pending-agent-reply-to", () => {
  beforeEach(() => {
    clearPendingAgentReplyToForTests();
  });

  it("FIFO per agent so concurrent mentions map to the right turns", () => {
    notePendingAgentReplyTo("s1", ["agent-a"], "u1");
    notePendingAgentReplyTo("s1", ["agent-a"], "u2");
    expect(peekPendingAgentReplyTo("s1", "agent-a")).toBe("u1");
    expect(takePendingAgentReplyTo("s1", "agent-a")).toBe("u1");
    expect(takePendingAgentReplyTo("s1", "agent-a")).toBe("u2");
    expect(takePendingAgentReplyTo("s1", "agent-a")).toBeNull();
  });

  it("isolates queues by actor", () => {
    notePendingAgentReplyTo("s1", ["a1", "a2"], "u-shared");
    expect(takePendingAgentReplyTo("s1", "a1")).toBe("u-shared");
    expect(takePendingAgentReplyTo("s1", "a2")).toBe("u-shared");
  });

  it("removes a stamped id from mid-queue so desync does not poison later turns", () => {
    notePendingAgentReplyTo("s1", ["agent-a"], "u1");
    notePendingAgentReplyTo("s1", ["agent-a"], "u2");
    notePendingAgentReplyTo("s1", ["agent-a"], "u3");
    expect(removePendingAgentReplyTo("s1", "agent-a", "u2")).toBe(true);
    expect(takePendingAgentReplyTo("s1", "agent-a")).toBe("u1");
    expect(takePendingAgentReplyTo("s1", "agent-a")).toBe("u3");
  });

  it("resolve prefers daemon stamp and dequeues that id anywhere", () => {
    notePendingAgentReplyTo("s1", ["agent-a"], "u1");
    notePendingAgentReplyTo("s1", ["agent-a"], "u2");
    expect(resolvePendingAgentReplyTo("s1", "agent-a", "u2")).toBe("u2");
    expect(peekPendingAgentReplyTo("s1", "agent-a")).toBe("u1");
    expect(resolvePendingAgentReplyTo("s1", "agent-a", "")).toBe("u1");
    expect(resolvePendingAgentReplyTo("s1", "agent-a", null)).toBeNull();
  });

  it("direct-append drain via remove leaves other queued parents intact", () => {
    notePendingAgentReplyTo("s1", ["agent-a"], "u1");
    notePendingAgentReplyTo("s1", ["agent-a"], "u2");
    expect(removePendingAgentReplyTo("s1", "agent-a", "u1")).toBe(true);
    expect(peekPendingAgentReplyTo("s1", "agent-a")).toBe("u2");
  });
});
