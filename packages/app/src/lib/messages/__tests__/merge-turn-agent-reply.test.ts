import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import {
  mergeTurnAgentReplyProto,
  protoPartsJson,
} from "@/lib/messages/merge-turn-agent-reply";

describe("mergeTurnAgentReplyProto", () => {
  it("keeps partsJson from enriched row when late MQTT row has attachments only", () => {
    const parts = JSON.stringify([
      { type: "tool-call", toolCall: { id: "t1", name: "session_attach_file" } },
      { type: "text", text: "done" },
    ]);
    const enriched = create(MessageSchema, {
      messageId: "local-flush",
      sessionId: "s1",
      senderActorId: "agent",
      kind: MessageKind.AGENT_REPLY,
      content: "done",
      turnId: "turn-1",
      metadataJson: "",
      createdAt: BigInt(1),
    });
    Object.assign(enriched, { partsJson: parts });

    const late = create(MessageSchema, {
      messageId: "cloud-id",
      sessionId: "s1",
      senderActorId: "agent",
      kind: MessageKind.AGENT_REPLY,
      content: "done",
      turnId: "turn-1",
      metadataJson: JSON.stringify({
        attachments: [{ filename: "a.txt", mime: "text/plain", size: 1, bucket_path: "p/a.txt" }],
      }),
      attachmentUrls: ["https://cdn.example.test/a.txt"],
      createdAt: BigInt(2),
    });

    const merged = mergeTurnAgentReplyProto(enriched, late);
    expect(protoPartsJson(merged)).toBe(parts);
    expect(merged.messageId).toBe("cloud-id");
    expect(JSON.parse(merged.metadataJson).attachments).toHaveLength(1);
    expect(merged.attachmentUrls).toEqual(["https://cdn.example.test/a.txt"]);
  });
});
