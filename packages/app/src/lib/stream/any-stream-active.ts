import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import { findStaleLiveStreams } from "@/lib/stream/stale-stream-recovery";

/**
 * True if any entry is genuinely streaming.
 *
 * "Active" per `byKey` alone over-counts: a dropped MQTT delta (QoS0) can leave
 * an entry `active: true` forever, which is exactly what `findStaleLiveStreams`
 * exists to detect. Restart-gating logic must not treat that as real activity,
 * or an update could wait out the full 24h ceiling for a turn that already
 * ended.
 */
export function computeAnyStreamActive(
  byKey: Record<string, AgentStreamEntry>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  now: number,
): boolean {
  const activeEntries = Object.entries(byKey).filter(([, entry]) => entry.active);
  if (activeEntries.length === 0) return false;

  const stale = findStaleLiveStreams({ byKey, byRuntimeId, now });
  if (stale.length === 0) return true;

  const staleKeys = new Set(stale.map((s) => `${s.sessionId}::${s.actorId}`));
  return activeEntries.some(([key]) => !staleKeys.has(key));
}

/**
 * True if any chat/agent turn anywhere in this window is genuinely streaming.
 *
 * Each store is subscribed through a selector that already reduces to this
 * boolean, so a text delta — which replaces `byKey` many times a second —
 * re-renders the caller only when the answer flips. Subscribing to `byKey`
 * itself re-rendered the update dialog on every delta of every stream.
 */
export function useAnyStreamActive(): boolean {
  const fromStreams = useV2StreamingStore((s) =>
    computeAnyStreamActive(
      s.byKey,
      useRuntimeStateStore.getState().byRuntimeId,
      Date.now(),
    ),
  );
  const fromRuntime = useRuntimeStateStore((s) =>
    computeAnyStreamActive(
      useV2StreamingStore.getState().byKey,
      s.byRuntimeId,
      Date.now(),
    ),
  );
  // Whichever store changed last computed against the other's current state,
  // so the two agree except while one is mid-update; recompute so the value
  // returned from this render reflects both stores as they are now.
  void fromStreams;
  void fromRuntime;
  return computeAnyStreamActive(
    useV2StreamingStore.getState().byKey,
    useRuntimeStateStore.getState().byRuntimeId,
    Date.now(),
  );
}
