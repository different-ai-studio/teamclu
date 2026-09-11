import {
  useV2StreamingStore,
  type CompactionWirePayload,
} from "@/stores/v2-streaming-store";

export function handleCompactionRawEvent(
  sessionId: string,
  actorId: string,
  method: string,
  jsonPayload: Uint8Array | undefined,
): boolean {
  if (method !== "compaction_start" && method !== "compaction_end") {
    return false;
  }
  let payload: CompactionWirePayload = {};
  try {
    payload = JSON.parse(
      new TextDecoder().decode(jsonPayload ?? new Uint8Array()),
    ) as CompactionWirePayload;
  } catch {
    // Best-effort: still show a generic compaction row.
  }
  const store = useV2StreamingStore.getState();
  if (method === "compaction_start") {
    store.beginCompaction(sessionId, actorId, payload);
  } else {
    store.completeCompaction(sessionId, actorId, {
      ...payload,
      completed: true,
    });
  }
  return true;
}
