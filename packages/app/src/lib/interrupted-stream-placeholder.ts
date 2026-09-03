import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { MessageKind } from "@/lib/proto/teamclu_pb";

type InterruptedPlaceholderRef = {
  streamId: string;
  messageId: string;
};

export function isInterruptedPlaceholderMessageId(messageId: string): boolean {
  return messageId.trim().startsWith("interrupt-");
}

/** interrupt-* AGENT_REPLY rows for this actor still sitting in the session store. */
export function listInterruptedPlaceholderIds(
  messages: TeamcluMessage[],
  actorId: string,
): string[] {
  const trimmedActor = actorId.trim();
  if (!trimmedActor) return [];
  const ids: string[] = [];
  for (const message of messages) {
    if (message.kind !== MessageKind.AGENT_REPLY) continue;
    if ((message.senderActorId ?? "").trim() !== trimmedActor) continue;
    if (!isInterruptedPlaceholderMessageId(message.messageId)) continue;
    ids.push(message.messageId);
  }
  return ids;
}

/**
 * Real daemon AGENT_REPLY should drop every synthetic interrupt placeholder for
 * this actor — both the tracked eager-flush ref and any leftover store rows.
 */
export function resolveInterruptedPlaceholdersToDrop(args: {
  tracked: InterruptedPlaceholderRef | undefined;
  messages: TeamcluMessage[];
  actorId: string;
}): { messageIds: string[] } {
  const ids = new Set<string>();
  if (args.tracked?.messageId) {
    ids.add(args.tracked.messageId);
  }
  for (const id of listInterruptedPlaceholderIds(args.messages, args.actorId)) {
    ids.add(id);
  }
  return { messageIds: [...ids] };
}
