import { describe, expect, it } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import {
  isInterruptedPlaceholderMessageId,
  listInterruptedPlaceholderIds,
  resolveInterruptedPlaceholdersToDrop,
} from "@/lib/messages/interrupted-stream-placeholder";

describe("interrupted-stream-placeholder", () => {
  it("detects interrupt- prefixed ids", () => {
    expect(isInterruptedPlaceholderMessageId("interrupt-s1::a1::stream-1")).toBe(
      true,
    );
    expect(isInterruptedPlaceholderMessageId("11111111-1111-1111-1111-111111111111")).toBe(
      false,
    );
  });

  it("lists only interrupt AGENT_REPLY rows for the actor", () => {
    const messages = [
      createMessage(MessageSchema, {
        messageId: "interrupt-stream-1",
        sessionId: "s1",
        senderActorId: "a1",
        kind: MessageKind.AGENT_REPLY,
        content: "synthetic",
        turnId: "interrupt-stream-1",
        createdAt: BigInt(1),
      }),
      createMessage(MessageSchema, {
        messageId: "real-1",
        sessionId: "s1",
        senderActorId: "a1",
        kind: MessageKind.AGENT_REPLY,
        content: "real",
        turnId: "turn-real",
        createdAt: BigInt(2),
      }),
      createMessage(MessageSchema, {
        messageId: "interrupt-other",
        sessionId: "s1",
        senderActorId: "a2",
        kind: MessageKind.AGENT_REPLY,
        content: "other",
        turnId: "interrupt-other",
        createdAt: BigInt(3),
      }),
    ];

    expect(listInterruptedPlaceholderIds(messages, "a1")).toEqual([
      "interrupt-stream-1",
    ]);
  });

  it("drops tracked id even when store is still empty (race before commit)", () => {
    const { messageIds } = resolveInterruptedPlaceholdersToDrop({
      tracked: { streamId: "stream-1", messageId: "interrupt-stream-1" },
      messages: [],
      actorId: "a1",
    });
    expect(messageIds).toEqual(["interrupt-stream-1"]);
  });

  it("unions tracked ref with leftover store rows", () => {
    const messages = [
      createMessage(MessageSchema, {
        messageId: "interrupt-stream-1",
        sessionId: "s1",
        senderActorId: "a1",
        kind: MessageKind.AGENT_REPLY,
        content: "synthetic",
        turnId: "interrupt-stream-1",
        createdAt: BigInt(1),
      }),
      createMessage(MessageSchema, {
        messageId: "interrupt-stream-stale",
        sessionId: "s1",
        senderActorId: "a1",
        kind: MessageKind.AGENT_REPLY,
        content: "stale",
        turnId: "interrupt-stream-stale",
        createdAt: BigInt(2),
      }),
    ];
    const { messageIds } = resolveInterruptedPlaceholdersToDrop({
      tracked: { streamId: "stream-1", messageId: "interrupt-stream-1" },
      messages,
      actorId: "a1",
    });
    expect(messageIds.sort()).toEqual([
      "interrupt-stream-1",
      "interrupt-stream-stale",
    ]);
  });
});
