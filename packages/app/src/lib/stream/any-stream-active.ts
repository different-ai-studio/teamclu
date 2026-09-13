import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { findStaleLiveStreams } from "@/lib/stream/stale-stream-recovery";

/**
 * True if any chat/agent turn anywhere in this window is genuinely streaming.
 *
 * "Active" per `byKey` alone over-counts: a dropped MQTT delta (QoS0) can leave
 * an entry `active: true` forever, which is exactly what `findStaleLiveStreams`
 * exists to detect. Restart-gating logic must not treat that as real activity,
 * or an update could wait out the full 24h ceiling for a turn that already
 * ended.
 */
export function useAnyStreamActive(): boolean {
  const byKey = useV2StreamingStore((s) => s.byKey);
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId);

  const activeEntries = Object.entries(byKey).filter(([, entry]) => entry.active);
  if (activeEntries.length === 0) return false;

  const stale = findStaleLiveStreams({ byKey, byRuntimeId, now: Date.now() });
  if (stale.length === 0) return true;

  const staleKeys = new Set(stale.map((s) => `${s.sessionId}::${s.actorId}`));
  return activeEntries.some(([key]) => !staleKeys.has(key));
}
