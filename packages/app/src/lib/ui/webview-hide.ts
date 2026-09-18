/** How long a hide gets to confirm before the webview is closed instead. */
export const HIDE_CONFIRM_TIMEOUT_MS = 1500

export type HideOutcome = "hidden" | "closed" | "stuck"

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * Take a native webview off the screen — by hiding it, or by destroying it when
 * hiding does not answer.
 *
 * Hiding is what we want: the webview keeps its page, its scroll position and
 * whatever the user was signed in to, so reopening the tab is instant. But the
 * hide has been watched to never come back — the Rust command logs that it
 * started and then produces nothing further, with every worker thread idle, so
 * it is not slow, it is gone. What that costs is not a lost login: a native
 * child webview is not part of the page, so one left showing covers whatever
 * the user switched to next, cannot be reached by anything in the UI, and stays
 * there until the app restarts. Against that, losing the page is cheap.
 *
 * So the hide gets a deadline, and missing it means the webview is closed. The
 * caller is told which happened, because a closed webview must also be dropped
 * from the caller's bookkeeping — the next open has to create it again.
 */
export async function hideNativeWebview(
  invoke: Invoke,
  label: string,
  timeoutMs: number = HIDE_CONFIRM_TIMEOUT_MS,
): Promise<HideOutcome> {
  let confirmed = false
  // A rejected hide still counts as answered: the command ran and said no,
  // which is a different thing from never returning, and the label may simply
  // be gone already.
  const hide = invoke("webview_hide", { label }).then(
    () => {
      confirmed = true
    },
    () => {
      confirmed = true
    },
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    hide,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  if (confirmed) return "hidden"

  try {
    await invoke("webview_close", { label })
    return "closed"
  } catch {
    // Both ways out are blocked. Nothing here can clear the screen, but saying
    // so in the log beats a silent catch when the next report arrives.
    console.warn(`[WebView] ${label} would neither hide nor close`)
    return "stuck"
  }
}
