import { create as createMessage } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MessageKind,
  type Message as TeamcluMessage,
} from "@/lib/proto/teamclu_pb";
import type { MessageRow } from "@/lib/cache/local-cache";
import { normalizeUnixTimestampSeconds } from "@/lib/messages/message-timestamp";

const kindMap: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  system: MessageKind.SYSTEM,
  agent_thinking: MessageKind.AGENT_THINKING,
  agent_tool_call: MessageKind.AGENT_TOOL_CALL,
  agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
  agent_reply: MessageKind.AGENT_REPLY,
};

export function messageRowsToProto(rows: MessageRow[]): TeamcluMessage[] {
  return rows.map((r) => {
    const proto = createMessage(MessageSchema, {
      messageId: r.id,
      sessionId: r.sessionId,
      senderActorId: r.senderActorId ?? "",
      kind: kindMap[r.kind] ?? MessageKind.TEXT,
      content: r.content ?? "",
      model: r.model ?? "",
      turnId: r.turnId ?? "",
      replyToMessageId: r.replyToMessageId ?? "",
      metadataJson: r.metadataJson ?? "",
      // Normalizing here also repairs existing local-cache rows written by a
      // legacy millisecond live event without mutating the cache during read.
      createdAt: normalizeUnixTimestampSeconds(new Date(r.createdAt).getTime()),
    });
    if (r.partsJson) {
      Object.assign(proto, { partsJson: r.partsJson });
    }
    return proto;
  });
}
