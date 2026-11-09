/**
 * Tracks the last flushed agent turn per session::actor so late ACP tool
 * events (after session.idle) can patch the persisted message instead of
 * reopening the live Composer dock.
 *
 * OpenCode desktop keeps one store and merges parts after idle; TeamClu
 * splits live dock vs message area — this registry bridges that handoff.
 */

type FlushedTurnRef = {
  messageId: string;
  streamId: string;
  turnId: string;
};

const byStreamKey = new Map<string, FlushedTurnRef>();
const turnGenerationByStreamKey = new Map<string, number>();

function key(sessionId: string, actorId: string): string {
  return `${sessionId.trim()}::${actorId.trim()}`;
}

/** Bumped by every turn open on session::actor. */
export function currentTurnGeneration(sessionId: string, actorId: string): number {
  return turnGenerationByStreamKey.get(key(sessionId, actorId)) ?? 0;
}

/**
 * A new turn opened. Events from here on belong to it, never to the previous
 * turn's persisted reply — keeping the old ref would drop the new turn's text
 * and patch its tools onto the old message whenever its live entry is closed.
 */
export function noteTurnOpened(sessionId: string, actorId: string): void {
  const k = key(sessionId, actorId);
  byStreamKey.delete(k);
  turnGenerationByStreamKey.set(k, currentTurnGeneration(sessionId, actorId) + 1);
}

/**
 * `turnGeneration` is the generation the flush started in. A flush that
 * resolves after the next turn opened must not re-register its turn.
 */
export function registerFlushedTurn(
  sessionId: string,
  actorId: string,
  ref: FlushedTurnRef,
  turnGeneration?: number,
): void {
  const sid = sessionId.trim();
  const aid = actorId.trim();
  const messageId = ref.messageId.trim();
  if (!sid || !aid || !messageId) return;
  if (
    turnGeneration !== undefined &&
    turnGeneration !== currentTurnGeneration(sid, aid)
  ) {
    return;
  }
  byStreamKey.set(key(sid, aid), {
    messageId,
    streamId: ref.streamId.trim(),
    turnId: ref.turnId.trim(),
  });
}

export function getFlushedTurn(
  sessionId: string,
  actorId: string,
): FlushedTurnRef | undefined {
  return byStreamKey.get(key(sessionId, actorId));
}

export function clearFlushedTurn(sessionId: string, actorId: string): void {
  byStreamKey.delete(key(sessionId, actorId));
}

/** @internal test helper */
export function resetFlushedTurnRegistryForTests(): void {
  byStreamKey.clear();
  turnGenerationByStreamKey.clear();
}
