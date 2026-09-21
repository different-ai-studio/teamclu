import { reconcileEquivalentAgentReplyText } from "@/lib/agent/agent-reply-transcript";
import type { Message } from "@/lib/proto/teamclu_pb";

export function protoPartsJson(m: Message): string {
  return (m as { partsJson?: string | null }).partsJson?.trim() ?? "";
}

function mergeMetadataJson(existing: string, incoming: string): string {
  if (!existing.trim()) return incoming;
  if (!incoming.trim()) return existing;
  try {
    const a = JSON.parse(existing) as Record<string, unknown>;
    const b = JSON.parse(incoming) as Record<string, unknown>;
    const attachments =
      Array.isArray(b.attachments) && b.attachments.length > 0
        ? b.attachments
        : a.attachments;
    const attachment_urls =
      Array.isArray(b.attachment_urls) && b.attachment_urls.length > 0
        ? b.attachment_urls
        : a.attachment_urls;
    return JSON.stringify({ ...a, ...b, attachments, attachment_urls });
  } catch {
    return incoming.trim() ? incoming : existing;
  }
}

/** Late MQTT rows may carry attachments while flush already persisted partsJson. */
export function mergeTurnAgentReplyProto(existing: Message, incoming: Message): Message {
  const partsJson = protoPartsJson(incoming) || protoPartsJson(existing);
  const content = reconcileEquivalentAgentReplyText(
    existing.content ?? "",
    incoming.content ?? "",
  );
  const attachmentUrls =
    incoming.attachmentUrls?.length > 0
      ? incoming.attachmentUrls
      : existing.attachmentUrls;
  const metadataJson = mergeMetadataJson(
    existing.metadataJson ?? "",
    incoming.metadataJson ?? "",
  );
  const merged = {
    ...incoming,
    content,
    metadataJson,
    attachmentUrls: attachmentUrls ?? [],
  } as Message & { partsJson?: string };
  if (partsJson) merged.partsJson = partsJson;
  else delete merged.partsJson;
  return merged;
}
