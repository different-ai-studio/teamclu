export const LOAD_EARLIER_MESSAGE_COUNT = 60;
export const LOAD_EARLIER_INTERSECTION_ROOT_MARGIN = "160px 0px 0px 0px";
/** Fallback when IntersectionObserver does not fire (e.g. some test envs). */
export const LOAD_EARLIER_SCROLL_TOP_THRESHOLD = 120;

export function expandVisibleMessageCount(
  currentVisible: number,
  totalMessages: number,
): number {
  const hidden = Math.max(0, totalMessages - currentVisible);
  if (hidden <= 0) return currentVisible;
  const batch = Math.min(LOAD_EARLIER_MESSAGE_COUNT, hidden);
  return Math.min(totalMessages, currentVisible + batch);
}
