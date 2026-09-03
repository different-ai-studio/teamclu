import { useV2StreamingStore } from "@/stores/v2-streaming-store";

/**
 * Micro-batches high-frequency streaming text deltas (MQTT acp.event
 * output/thinking) into at most one store mutation per animation frame.
 * Order between output and thinking chunks is preserved; any consumer that
 * READS ordered stream state (tool events, statusChange, finalize, persist)
 * must call flushStreamDeltasFor()/flushAllStreamDeltas() first.
 */
type StreamDeltaKind = "output" | "thinking";

interface BufferedDelta {
  kind: StreamDeltaKind;
  delta: string;
}

const pending = new Map<string, BufferedDelta[]>();
let rafId: number | null = null;

const keyOf = (sessionId: string, actorId: string) => `${sessionId}::${actorId}`;

export function bufferStreamDelta(
  kind: StreamDeltaKind,
  sessionId: string,
  actorId: string,
  delta: string,
): void {
  if (!delta) return;
  const key = keyOf(sessionId, actorId);
  const list = pending.get(key);
  if (list) list.push({ kind, delta });
  else pending.set(key, [{ kind, delta }]);
  if (rafId !== null) return;
  if (typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      flushAllStreamDeltas();
    });
    return;
  }
  queueMicrotask(() => {
    flushAllStreamDeltas();
  });
}

function applyBuffered(
  sessionId: string,
  actorId: string,
  list: BufferedDelta[],
): void {
  const store = useV2StreamingStore.getState();
  let runKind: StreamDeltaKind | null = null;
  let run: string[] = [];
  const emit = () => {
    if (!runKind || run.length === 0) return;
    if (runKind === "output") store.appendOutputBatch(sessionId, actorId, run);
    else store.appendThinkingBatch(sessionId, actorId, run);
  };
  for (const { kind, delta } of list) {
    if (kind === runKind) {
      run.push(delta);
    } else {
      emit();
      runKind = kind;
      run = [delta];
    }
  }
  emit();
}

export function flushStreamDeltasFor(sessionId: string, actorId: string): void {
  const key = keyOf(sessionId, actorId);
  const list = pending.get(key);
  if (!list) return;
  pending.delete(key);
  applyBuffered(sessionId, actorId, list);
}

export function flushAllStreamDeltas(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  const drained = [...pending.entries()];
  pending.clear();
  for (const [key, list] of drained) {
    const sep = key.indexOf("::");
    applyBuffered(key.slice(0, sep), key.slice(sep + 2), list);
  }
}

export function __resetStreamDeltaBufferForTests(): void {
  if (rafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(rafId);
  }
  pending.clear();
  rafId = null;
}
