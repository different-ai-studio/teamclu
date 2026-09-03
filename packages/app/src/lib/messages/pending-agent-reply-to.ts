/**
 * Per-(session, agent) FIFO of user message ids that should become
 * `replyToMessageId` on the next agent turn flush when the daemon did not
 * stamp one. Push on local send; consume on flush so concurrent @mentions stay
 * ordered (u1,u2 → a1 replies to u1, a2 to u2).
 *
 * When the daemon stamps a reply_to, remove that id from anywhere in the queue
 * (not only the head) so a scrambled FIFO cannot keep poisoning later turns.
 */
const queues = new Map<string, string[]>();

function key(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

export function notePendingAgentReplyTo(
  sessionId: string,
  actorIds: readonly string[],
  userMessageId: string,
): void {
  const id = userMessageId.trim();
  if (!sessionId || !id || actorIds.length === 0) return;
  for (const actorId of actorIds) {
    if (!actorId) continue;
    const k = key(sessionId, actorId);
    const q = queues.get(k) ?? [];
    q.push(id);
    queues.set(k, q);
  }
}

/** Peek without consuming — for live dock while the turn is still open. */
export function peekPendingAgentReplyTo(
  sessionId: string,
  actorId: string,
): string | null {
  const q = queues.get(key(sessionId, actorId));
  return q?.[0] ?? null;
}

/** Consume the oldest pending id for this agent (one per flushed turn). */
export function takePendingAgentReplyTo(
  sessionId: string,
  actorId: string,
): string | null {
  const k = key(sessionId, actorId);
  const q = queues.get(k);
  if (!q?.length) return null;
  const next = q.shift() ?? null;
  if (q.length === 0) queues.delete(k);
  else queues.set(k, q);
  return next;
}

/** Remove the first matching id anywhere in the queue (daemon-stamped path). */
export function removePendingAgentReplyTo(
  sessionId: string,
  actorId: string,
  messageId: string,
): boolean {
  const id = messageId.trim();
  if (!sessionId || !actorId || !id) return false;
  const k = key(sessionId, actorId);
  const q = queues.get(k);
  if (!q?.length) return false;
  const idx = q.indexOf(id);
  if (idx < 0) return false;
  q.splice(idx, 1);
  if (q.length === 0) queues.delete(k);
  else queues.set(k, q);
  return true;
}

/**
 * Prefer daemon stamp; otherwise take FIFO head. Always dequeue the stamp
 * when present so the queue stays aligned with completed turns.
 */
export function resolvePendingAgentReplyTo(
  sessionId: string,
  actorId: string,
  stampedReplyTo: string | null | undefined,
): string | null {
  const stamped = stampedReplyTo?.trim() || "";
  if (stamped) {
    removePendingAgentReplyTo(sessionId, actorId, stamped);
    return stamped;
  }
  return takePendingAgentReplyTo(sessionId, actorId);
}

export function clearPendingAgentReplyToForTests(): void {
  queues.clear();
}
