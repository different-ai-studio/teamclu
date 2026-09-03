import { splitAssistantProcessAndFinalParts } from "@/lib/agent/agent-reply-transcript";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import type { Message as SdkMessage, MessagePart } from "@/stores/session-types";
import { buildFullTurnSdkMessageFromGroup } from "@/lib/messages/v2-message-adapter";

const deferredProcessCache = new Map<string, MessagePart[]>();

function renderableParts(parts: MessagePart[]): MessagePart[] {
  return parts.filter(
    (p) =>
      (p.type === "reasoning" && Boolean(p.text || p.content)) ||
      (p.type === "text" && Boolean(p.text || p.content)) ||
      (p.type === "tool-call" && Boolean(p.toolCall)),
  );
}

/** Hydrate collapsed process parts for a deferred historical turn (cached per message). */
export function hydrateDeferredProcessParts(
  protos: TeamcluMessage[] | undefined,
  message: Pick<SdkMessage, "id" | "lazyProcessRef">,
): MessagePart[] {
  const ref = message.lazyProcessRef;
  if (!protos?.length || !ref) return [];

  const cacheKey = `${ref.sessionId}:${message.id}`;
  const cached = deferredProcessCache.get(cacheKey);
  if (cached) return cached;

  const group = protos.filter(
    (p) => p.turnId === ref.turnId && p.senderActorId === ref.senderActorId,
  );
  if (group.length === 0) return [];

  const full = buildFullTurnSdkMessageFromGroup(group);
  const { processParts } = splitAssistantProcessAndFinalParts(
    renderableParts(full.parts),
  );
  deferredProcessCache.set(cacheKey, processParts);
  return processParts;
}

export function clearDeferredProcessCache(sessionId?: string): void {
  if (!sessionId) {
    deferredProcessCache.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of deferredProcessCache.keys()) {
    if (key.startsWith(prefix)) deferredProcessCache.delete(key);
  }
}
