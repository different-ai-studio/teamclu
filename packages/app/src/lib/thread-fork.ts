import { resolveThreadForkFrom } from "@/lib/thread-fork-metadata";

/** Ephemeral composer key before lazy thread session create. */
export function threadDraftSessionId(
  parentSessionId: string,
  rootMessageId: string,
): string {
  return `thread-draft:${parentSessionId}:${rootMessageId}`;
}

/** RuntimeStart fork anchor for a thread session (session-attached, not UI store). */
export function runtimeForkFromForSession(
  sessionId: string,
): { parentSessionId: string; rootMessageId: string } | undefined {
  return resolveThreadForkFrom(sessionId);
}
