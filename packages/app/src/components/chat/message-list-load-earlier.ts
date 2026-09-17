export const LOAD_EARLIER_MESSAGE_COUNT = 60;
/** Only treat as "at top" when scrollTop is within this many px of 0. */
export const LOAD_EARLIER_AT_TOP_THRESHOLD = 4;
/** Wait after reaching top before loading (avoids flick / momentum false triggers). */
export const LOAD_EARLIER_TOP_DEBOUNCE_MS = 200;
/**
 * How long the spinner is on screen before the older messages are prepended.
 *
 * The prepend is local and instant, so without a deliberate hold the spinner and
 * the messages it claims to be fetching land in the same commit — it reads as
 * decoration, and the list never comes to rest at the top long enough for the
 * reader to feel they reached a boundary. This buys both.
 */
export const LOAD_EARLIER_HOLD_MS = 420;

export function isScrollAtTop(scrollTop: number): boolean {
  return scrollTop <= LOAD_EARLIER_AT_TOP_THRESHOLD;
}

export function expandVisibleMessageCount(
  currentVisible: number,
  totalMessages: number,
): number {
  const hidden = Math.max(0, totalMessages - currentVisible);
  if (hidden <= 0) return currentVisible;
  const batch = Math.min(LOAD_EARLIER_MESSAGE_COUNT, hidden);
  return Math.min(totalMessages, currentVisible + batch);
}
