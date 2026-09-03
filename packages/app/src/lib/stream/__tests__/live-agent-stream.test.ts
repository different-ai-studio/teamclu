import { beforeEach, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { AgentStatus } from "@/lib/proto/amux_pb";
import {
  MessageKind,
  MessageSchema,
  type Message as TeamcluMessage,
} from "@/lib/proto/teamclu_pb";
import {
  buildInterruptedStreamAnchor,
  isAgentActiveStatus,
  isTurnOpeningStatusChange,
  isTerminalAgentStatus,
  joinDistinctPendingReplyChunks,
  isToolOnlyTurnAnchor,
  mergePendingAgentReplies,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
  rememberLiveEventId,
  streamTranscriptHasText,
  streamTranscriptRevision,
  streamEntryHasVisibleContent,
  shouldPatchFlushedToolEvent,
} from "@/lib/stream/live-agent-stream";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import {
  registerFlushedTurn,
  resetFlushedTurnRegistryForTests,
} from "@/lib/stream/flushed-turn-registry";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useSessionMessageStore } from "@/stores/session-message-store";

describe("live agent stream event helpers", () => {
  it("normalizes execute tool uses preserving wire name when absent", () => {
    expect(
      normalizeToolUseEvent({
        tool_id: "tool-1",
        tool_kind: "execute",
        description: '{"command":"ps aux"}',
      }),
    ).toEqual({
      toolId: "tool-1",
      toolName: "unknown",
      description: '{"command":"ps aux"}',
      params: { command: "ps aux" },
      toolKind: "execute",
    });
  });

  it("preserves explicit ACP tool_name on the wire", () => {
    expect(
      normalizeToolUseEvent({
        tool_id: "tool-1",
        tool_name: "glob",
        tool_kind: "search",
        params: { pattern: "**/*.ts", path: "." },
      }),
    ).toEqual({
      toolId: "tool-1",
      toolName: "glob",
      description: "",
      params: { pattern: "**/*.ts", path: "." },
      toolKind: "search",
    });
  });

  it("maps other-kind skill tool uses to the skill route", () => {
    expect(
      normalizeToolUseEvent({
        tool_id: "tool-skill",
        tool_name: "other",
        tool_kind: "other",
        description: "skill",
        params: { name: "brainstorming", description: "skill" },
      }),
    ).toEqual({
      toolId: "tool-skill",
      toolName: "other",
      description: "skill",
      params: { name: "brainstorming", description: "skill" },
      toolKind: "other",
    });
  });

  it("keeps explicit params when description is only a title", () => {
    expect(
      normalizeToolUseEvent({
        toolId: "tool-1",
        toolName: "Execute ps command",
        toolKind: "execute",
        description: "Execute ps command",
        params: { command: "ps aux", description: "Execute ps command" },
      }),
    ).toEqual({
      toolId: "tool-1",
      toolName: "Execute ps command",
      description: "Execute ps command",
      params: { command: "ps aux", description: "Execute ps command" },
      toolKind: "execute",
    });
  });

  it("normalizes camelCase tool result fields", () => {
    expect(
      normalizeToolResultEvent({
        toolId: "tool-1",
        success: "true",
        summary: "done",
      }),
    ).toEqual({
      toolId: "tool-1",
      success: true,
      summary: "done",
    });
  });

  it("recognizes terminal agent statuses", () => {
    expect(isTerminalAgentStatus(AgentStatus.IDLE)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.ERROR)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.STOPPED)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.ACTIVE)).toBe(false);
  });

  it("recognizes active agent status for planning placeholder", () => {
    expect(isAgentActiveStatus(AgentStatus.ACTIVE)).toBe(true);
    expect(isAgentActiveStatus(AgentStatus.IDLE)).toBe(false);
    expect(isAgentActiveStatus(2)).toBe(true);
  });

  it("recognizes turn-opening statusChange only for Idle to Active", () => {
    expect(
      isTurnOpeningStatusChange(AgentStatus.IDLE, AgentStatus.ACTIVE),
    ).toBe(true);
    expect(
      isTurnOpeningStatusChange(AgentStatus.ACTIVE, AgentStatus.ACTIVE),
    ).toBe(false);
    expect(
      isTurnOpeningStatusChange(AgentStatus.ACTIVE, AgentStatus.IDLE),
    ).toBe(false);
  });

  it("dedupes repeated live event ids per session", () => {
    const seen = new Set<string>();
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(true);
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(false);
    expect(rememberLiveEventId(seen, "s2", "evt-1")).toBe(true);
  });

  it("derives merged content from transcript parts when present", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamcluMessage[];
    expect(
      mergePendingAgentReplies(pending, {
        parts: [
          { type: "text", text: "CPU Top 3" },
          { type: "tool-call", toolCall: { id: "t1" } },
          { type: "text", text: "Memory Top 3" },
        ],
      })?.content,
    ).toBe("CPU Top 3\n\nMemory Top 3");
  });

  it("falls back to joined pending when transcript has no text parts", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamcluMessage[];
    expect(mergePendingAgentReplies(pending)?.content).toBe(
      "CPU Top 3\n\nMemory Top 3",
    );
  });

  it("reconciles single-segment typo drift from daemon final slice", () => {
    const stream =
      "好的，我整理了两种方案：\n\n**方案 A** 单文件。\n\n**方案 B** React。\n\n**我推荐方案 A**——够用。适合之后想再改、加点功能。你觉得呢？";
    const daemon = stream.replace("再改、", "再改改、");
    const pending = [{ messageId: "m1", content: daemon }] as TeamcluMessage[];
    const merged = mergePendingAgentReplies(pending, {
      parts: [{ type: "text", text: stream }],
    });
    expect(merged?.content).toBe(daemon);
    expect(merged?.content).not.toContain(`${daemon}\n\n${stream}`);
  });

  it("joinDistinctPendingReplyChunks merges non-overlapping slices", () => {
    const pending = [
      { messageId: "m1", content: "First part." },
      { messageId: "m2", content: "Second part." },
    ] as TeamcluMessage[];
    expect(joinDistinctPendingReplyChunks(pending)).toBe(
      "First part.\n\nSecond part.",
    );
  });

  it("treats parked empty agent replies as no reply when the stream has no artifacts", () => {
    const pending = [
      { messageId: "m1", content: "" },
      { messageId: "m2", content: "   " },
    ] as TeamcluMessage[];
    expect(mergePendingAgentReplies(pending)).toBeNull();
  });

  it("keeps tool-only turn anchors even when agent_reply content is empty", () => {
    const pending = [{ messageId: "m1", content: "" }] as TeamcluMessage[];
    const streamEntry = {
      outputText: "",
      thinkingText: "",
      toolCalls: [{ id: "sleep-tool" }],
      parts: [
        {
          type: "tool-call",
          toolCall: { id: "sleep-tool", status: "calling" },
        },
      ],
    };
    expect(mergePendingAgentReplies(pending, streamEntry)).toMatchObject({
      messageId: "m1",
      content: "",
    });
    expect(isToolOnlyTurnAnchor(pending, streamEntry)).toBe(true);
  });

  it("detects when a stream ended without any visible content", () => {
    expect(streamEntryHasVisibleContent(undefined)).toBe(false);
    expect(
      streamEntryHasVisibleContent({
        outputText: " ",
        thinkingText: "",
        toolCalls: [],
        parts: [],
      }),
    ).toBe(false);
    expect(
      streamEntryHasVisibleContent({
        outputText: "",
        thinkingText: "",
        toolCalls: [{ id: "tool-1" }],
        parts: [],
      }),
    ).toBe(true);
    expect(
      streamEntryHasVisibleContent({
        outputText: "",
        thinkingText: "",
        toolCalls: [],
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });

  it("streamTranscriptHasText ignores tool-only streams", () => {
    expect(
      streamTranscriptHasText({
        outputText: "",
        thinkingText: "",
        toolCalls: [{ id: "tool-1" }],
        parts: [{ type: "tool-call", toolCall: { id: "tool-1" } }],
      }),
    ).toBe(false);
    expect(
      streamTranscriptHasText({
        outputText: "",
        thinkingText: "",
        toolCalls: [],
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });

  it("streamTranscriptRevision ignores tool status changes", () => {
    const base = {
      outputText: "",
      thinkingText: "",
      toolCalls: [{ id: "tool-1", name: "bash", status: "waiting" }],
      parts: [{ type: "tool-call", toolCall: { id: "tool-1", status: "waiting" } }],
    };
    expect(streamTranscriptRevision(base)).toBe(
      streamTranscriptRevision({
        ...base,
        toolCalls: [{ id: "tool-1", name: "bash", status: "completed", result: "ok" }],
        parts: [
          {
            type: "tool-call",
            toolCall: { id: "tool-1", status: "completed", result: "ok" },
          },
        ],
      }),
    );
  });

  it("streamTranscriptRevision changes when transcript content grows", () => {
    const before = streamTranscriptRevision({
      parts: [{ type: "text", text: "Hello" }],
    });
    const after = streamTranscriptRevision({
      parts: [{ type: "text", text: "Hello world" }],
    });
    expect(before).not.toBe(after);
  });

  it("buildInterruptedStreamAnchor uses streamId for stable client ids", () => {
    const snapshot: AgentStreamEntry = {
      sessionId: "s1",
      actorId: "a1",
      outputText: "",
      thinkingText: "",
      parts: [{ type: "tool-call", toolCall: { id: "tool-1" } }],
      toolCalls: [
        {
          id: "tool-1",
          name: "bash",
          status: "completed",
          startTime: new Date("2026-06-08T07:38:00.000Z"),
        },
      ],
      planEntries: [],
      pendingPermissionsByRequestId: {},
      errorMessage: null,
      errorDetails: null,
      lastUpdate: 1_748_868_000_000,
      active: false,
      streamId: "s1::a1::stream-9",
    };
    const anchor = buildInterruptedStreamAnchor("s1", "a1", snapshot);
    expect(anchor.messageId).toBe("interrupt-s1::a1::stream-9");
    expect(anchor.turnId).toBe("interrupt-s1::a1::stream-9");
    expect(Number(anchor.createdAt)).toBe(
      Math.floor(new Date("2026-06-08T07:38:00.000Z").getTime() / 1000),
    );
  });
});

describe("shouldPatchFlushedToolEvent", () => {
  beforeEach(() => {
    resetFlushedTurnRegistryForTests();
    useV2StreamingStore.setState({
      byKey: {},
      archived: [],
      revisionBySession: {},
      interruptedFlushPending: {},
    });
    useSessionMessageStore.setState({ messages: {} });
  });

  it("patches when the live stream is inactive after flush", () => {
    registerFlushedTurn("s1", "a1", {
      messageId: "m1",
      streamId: "stream-1",
      turnId: "turn-1",
    });
    expect(shouldPatchFlushedToolEvent("s1", "a1", "tool-late", undefined)).toBe(true);
  });

  it("patches orphan tools already on the flushed reply while follow-up dock is open", () => {
    const reply = create(MessageSchema, {
      messageId: "m1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: "done",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });
    Object.assign(reply, {
      partsJson: JSON.stringify([
        {
          id: "stream:tool:turn1-tool",
          type: "tool-call",
          toolCallId: "turn1-tool",
          toolCall: { id: "turn1-tool", name: "grep", status: "calling" },
        },
      ]),
    });
    useSessionMessageStore.getState().replaceTurnAgentRepliesInStore("s1", reply);
    registerFlushedTurn("s1", "a1", {
      messageId: "m1",
      streamId: "stream-1",
      turnId: "turn-1",
    });
    useV2StreamingStore.getState().beginPlanningPlaceholder("s1", "a1");
    const live = useV2StreamingStore.getState().byKey["s1::a1"] as AgentStreamEntry;
    expect(live.streamId).not.toBe("stream-1");
    expect(shouldPatchFlushedToolEvent("s1", "a1", "turn1-tool", live)).toBe(true);
  });

  it("keeps the first turn-2 toolUse on the live stream (not turn-1 parts)", () => {
    const reply = create(MessageSchema, {
      messageId: "m1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: "turn 1 reply",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });
    Object.assign(reply, {
      partsJson: JSON.stringify([
        { id: "p1", type: "text", text: "turn 1 reply", content: "turn 1 reply" },
      ]),
    });
    useSessionMessageStore.getState().replaceTurnAgentRepliesInStore("s1", reply);
    registerFlushedTurn("s1", "a1", {
      messageId: "m1",
      streamId: "stream-1",
      turnId: "turn-1",
    });
    useV2StreamingStore.getState().beginPlanningPlaceholder("s1", "a1");
    const live = useV2StreamingStore.getState().byKey["s1::a1"] as AgentStreamEntry;
    expect(live.streamId).not.toBe("stream-1");
    expect(live.toolCalls).toHaveLength(0);
    // Regression: brand-new tool ids must not patch the prior flushed reply.
    expect(shouldPatchFlushedToolEvent("s1", "a1", "turn2-tool", live)).toBe(false);
  });

  it("keeps current-turn tools on the live stream", () => {
    registerFlushedTurn("s1", "a1", {
      messageId: "m1",
      streamId: "stream-1",
      turnId: "turn-1",
    });
    useV2StreamingStore.getState().beginPlanningPlaceholder("s1", "a1");
    useV2StreamingStore.getState().pushToolUse("s1", "a1", {
      toolId: "turn2-tool",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });
    const live = useV2StreamingStore.getState().byKey["s1::a1"] as AgentStreamEntry;
    expect(shouldPatchFlushedToolEvent("s1", "a1", "turn2-tool", live)).toBe(false);
  });
});
