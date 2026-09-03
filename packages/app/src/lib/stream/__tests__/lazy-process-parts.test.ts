import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclu_pb";
import {
  clearDeferredProcessCache,
  hydrateDeferredProcessParts,
} from "@/lib/stream/lazy-process-parts";
import { adaptTeamcluMessages } from "@/lib/messages/v2-message-adapter";

function tmsg(o: {
  kind?: MessageKind;
  content?: string;
  metadataJson?: string;
  turnId?: string;
  t?: number;
}) {
  return create(MessageSchema, {
    messageId: `msg-${o.t ?? 0}`,
    sessionId: "s1",
    senderActorId: "actor-a",
    kind: o.kind ?? MessageKind.AGENT_REPLY,
    content: o.content ?? "",
    metadataJson: o.metadataJson ?? "",
    model: "",
    turnId: o.turnId ?? "turn-1",
    replyToMessageId: "",
    createdAt: BigInt(o.t ?? 0),
  });
}

describe("lazy-process-parts", () => {
  beforeEach(() => {
    clearDeferredProcessCache();
  });

  it("hydrates deferred process parts from proto rows", () => {
    const toolId = "tool-1";
    const protos = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "read", description: "file" }),
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "done",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        t: 2,
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "Answer.",
        t: 3,
      }),
    ];

    const deferred = adaptTeamcluMessages(protos, { deferProcess: true })!;
    const message = deferred[0];
    expect(message.processDeferred).toBe(true);

    const parts = hydrateDeferredProcessParts(protos, message);
    expect(parts.some((p) => p.type === "tool-call")).toBe(true);

    const cached = hydrateDeferredProcessParts(protos, message);
    expect(cached).toBe(parts);
  });

  it("clearDeferredProcessCache drops entries for one session", () => {
    const protos = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: "t1", tool_name: "bash", description: "ls" }),
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "ok",
        metadataJson: JSON.stringify({ tool_id: "t1", success: true }),
        t: 2,
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "Done.",
        t: 3,
      }),
    ];

    const deferred = adaptTeamcluMessages(protos, { deferProcess: true })!;
    hydrateDeferredProcessParts(protos, deferred[0]);
    clearDeferredProcessCache("s1");

    const again = hydrateDeferredProcessParts(protos, deferred[0]);
    expect(again.length).toBeGreaterThan(0);
  });
});
