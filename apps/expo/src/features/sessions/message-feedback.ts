import type { FeedbackKind, MessageFeedbackRecord } from "./cloud-api";

/** The signed-in member's own feedback, by message id (iOS `loadFeedback`). */
export function myFeedbackByMessageId(
  rows: ReadonlyArray<MessageFeedbackRecord>,
  myActorId: string,
): Map<string, FeedbackKind> {
  const mine = new Map<string, FeedbackKind>();
  for (const row of rows) {
    if (row.actorId === myActorId) mine.set(row.messageId, row.kind);
  }
  return mine;
}

/** Tapping the active choice again clears it; anything else sets it. */
export function nextFeedback(
  current: FeedbackKind | undefined,
  tapped: FeedbackKind,
): FeedbackKind | null {
  return current === tapped ? null : tapped;
}
