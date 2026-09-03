import { resolveThreadForkFrom } from "@/lib/session/thread-fork-metadata";

/** Only the newest N parent messages may show the "start thread" affordance. */
export const THREAD_FORK_MESSAGE_WINDOW = 100;

export function canStartThreadFromNewestIndex(indexFromNewest: number): boolean {
  return indexFromNewest >= 0 && indexFromNewest < THREAD_FORK_MESSAGE_WINDOW;
}

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
