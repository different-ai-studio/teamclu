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

function key(sessionId: string, actorId: string): string {
  return `${sessionId.trim()}::${actorId.trim()}`;
}

export function registerFlushedTurn(
  sessionId: string,
  actorId: string,
  ref: FlushedTurnRef,
): void {
  const sid = sessionId.trim();
  const aid = actorId.trim();
  const messageId = ref.messageId.trim();
  if (!sid || !aid || !messageId) return;
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
}
