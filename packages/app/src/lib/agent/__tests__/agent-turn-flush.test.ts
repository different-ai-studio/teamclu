import { describe, expect, it, vi, beforeEach } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import {
  buildAgentReplyMessageRow,
  executeAgentTurnFlush,
} from "@/lib/agent/agent-turn-flush";
import {
  getFlushedTurn,
  noteTurnOpened,
  resetFlushedTurnRegistryForTests,
} from "@/lib/stream/flushed-turn-registry";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

vi.mock("@/lib/cache/local-cache", () => ({
  enrichMessageParts: vi.fn(async (partsJson: string) => partsJson),
  setMessageParts: vi.fn(async (_id: string, partsJson: string) => partsJson),
  upsertMessagesBatch: vi.fn(async () => undefined),
}));

vi.mock("@/lib/stream/stream-delta-buffer", () => ({
  flushStreamDeltasFor: vi.fn(),
}));

describe("agent-turn-flush", () => {
  beforeEach(() => {
    useSessionMessageStore.setState({
      messages: {},
      messageRefreshTrigger: 0,
      messageRefreshForceFull: false,
    });
    useV2StreamingStore.setState({
      byKey: {},
      archived: [],
      persistedPlansBySession: {},
    });
  });

  it("buildAgentReplyMessageRow maps proto fields to cache row", () => {
    const reply = createMessage(MessageSchema, {
      messageId: "msg-1",
      sessionId: "s1",
      senderActorId: "agent-1",
      kind: MessageKind.AGENT_REPLY,
      content: "hello",
      turnId: "turn-1",
      model: "gpt-test",
      createdAt: BigInt(1_700_000_000),
    });
    const row = buildAgentReplyMessageRow("team-1", reply);
    expect(row.id).toBe("msg-1");
    expect(row.teamId).toBe("team-1");
    expect(row.kind).toBe("agent_reply");
    expect(row.turnId).toBe("turn-1");
    expect(row.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(row.partsJson).toBeNull();
  });

  it("shouldCommit=false skips inserting the synthetic reply", async () => {
    const reply = createMessage(MessageSchema, {
      messageId: "interrupt-stream-1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: "synthetic body",
      turnId: "interrupt-stream-1",
      createdAt: BigInt(100),
    });

    await executeAgentTurnFlush({
      sessionId: "s1",
      actorId: "a1",
      trigger: "test.superseded",
      teamId: "team-1",
      reply,
      pendingReplies: [],
      shouldCommit: () => false,
      persistedStage: "test.persisted",
    });

    const rows = useSessionMessageStore.getState().messages.s1 ?? [];
    expect(rows.find((m) => m.messageId === "interrupt-stream-1")).toBeUndefined();
  });

  it("a flush that resolves after the next turn opened does not re-register its turn", async () => {
    resetFlushedTurnRegistryForTests();
    const reply = createMessage(MessageSchema, {
      messageId: "msg-turn-1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: "turn 1",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    const flushing = executeAgentTurnFlush({
      sessionId: "s1",
      actorId: "a1",
      trigger: "mqtt.statusChange.active",
      teamId: "team-1",
      reply,
      pendingReplies: [reply],
      persistedStage: "test.persisted",
    });
    noteTurnOpened("s1", "a1");
    await flushing;

    expect(getFlushedTurn("s1", "a1")).toBeUndefined();
    const rows = useSessionMessageStore.getState().messages.s1 ?? [];
    expect(rows.find((m) => m.messageId === "msg-turn-1")).toBeDefined();
  });

  it("a flush within the same turn registers it", async () => {
    resetFlushedTurnRegistryForTests();
    const reply = createMessage(MessageSchema, {
      messageId: "msg-turn-1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: "turn 1",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await executeAgentTurnFlush({
      sessionId: "s1",
      actorId: "a1",
      trigger: "mqtt.statusChange.terminal",
      teamId: "team-1",
      reply,
      pendingReplies: [reply],
      persistedStage: "test.persisted",
    });

    expect(getFlushedTurn("s1", "a1")?.messageId).toBe("msg-turn-1");
  });
});
