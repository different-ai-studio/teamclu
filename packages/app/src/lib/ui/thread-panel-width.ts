/** Preference for the agent-reply thread side panel. Last writer wins. */
export const THREAD_PANEL_WIDTH_DEFAULT = 380
export const THREAD_PANEL_WIDTH_MIN = 300
/** Hard cap: the panel never takes more than half the window. */
export const THREAD_PANEL_WINDOW_RATIO = 0.5

/** Leave a sliver of the chat column so the divider can still be dragged back. */
const CHAT_COLUMN_MIN = 48
const STORAGE_KEY = "teamclu.threadPanelWidth"
const RESIZE_HINT_SEEN_KEY = "teamclu.threadPanelResizeHintSeen"

/** Once per install. Applies to every session on this machine. */
export function hasSeenThreadPanelResizeHint(): boolean {
  try {
    return localStorage.getItem(RESIZE_HINT_SEEN_KEY) === "1"
  } catch {
    return true
  }
}

export function markThreadPanelResizeHintSeen(): void {
  try {
    localStorage.setItem(RESIZE_HINT_SEEN_KEY, "1")
  } catch {
    /* preference only */
  }
}

export type ThreadPanelWidthLimits = {
  windowWidth?: number
  containerWidth?: number
}

export function threadPanelWidthMax(limits?: ThreadPanelWidthLimits): number {
  let max = Number.POSITIVE_INFINITY
  const windowWidth = limits?.windowWidth
  const containerWidth = limits?.containerWidth
  if (windowWidth != null && Number.isFinite(windowWidth) && windowWidth > 0) {
    max = Math.min(max, Math.floor(windowWidth * THREAD_PANEL_WINDOW_RATIO))
  }
  if (containerWidth != null && Number.isFinite(containerWidth) && containerWidth > 0) {
    max = Math.min(max, Math.floor(containerWidth - CHAT_COLUMN_MIN))
  }
  if (!Number.isFinite(max)) return Number.POSITIVE_INFINITY
  return Math.max(THREAD_PANEL_WIDTH_MIN, max)
}

export function clampThreadPanelWidth(width: number, limits?: ThreadPanelWidthLimits): number {
  const max = threadPanelWidthMax(limits)
  const fallback = Math.min(max, THREAD_PANEL_WIDTH_DEFAULT)
  if (!Number.isFinite(width)) return fallback
  return Math.min(max, Math.max(THREAD_PANEL_WIDTH_MIN, Math.round(width)))
}

export function readThreadPanelWidth(limits?: ThreadPanelWidthLimits): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null || raw === "") {
      return clampThreadPanelWidth(THREAD_PANEL_WIDTH_DEFAULT, limits)
    }
    return clampThreadPanelWidth(Number(raw), limits)
  } catch {
    return clampThreadPanelWidth(THREAD_PANEL_WIDTH_DEFAULT, limits)
  }
}

export function writeThreadPanelWidth(width: number, limits?: ThreadPanelWidthLimits): number {
  const next = clampThreadPanelWidth(width, limits)
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    /* preference only */
  }
  return next
}

/** Pointer moving right (positive deltaX) narrows the right-hand panel. */
export function resizeThreadPanelWidth(
  current: number,
  deltaX: number,
  limits?: ThreadPanelWidthLimits,
): number {
  return clampThreadPanelWidth(current - deltaX, limits)
}
