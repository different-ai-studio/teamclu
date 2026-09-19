import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, ExternalLink, RotateCw } from "lucide-react"
import { isTauri } from "@/lib/utils"
import { normalizeUrl, urlToLabel } from "@/lib/ui/webview-utils"
import { useTabsStore } from "@/stores/tabs"
import { useCurrentTeamStore } from "@/stores/current-team"
import { adminSsoInjectionFor } from "@/lib/extension/admin-sso-inject"
import { hideNativeWebview } from "@/lib/ui/webview-hide"

interface WebViewContentProps {
  url: string
}

// Track which webview labels have been created (globally, survives component unmount)
const createdWebviews = new Set<string>()
// Track webviews whose tabs were closed — need URL reset when reopened
const needsUrlReset = new Set<string>()

/**
 * Take the webview off screen and keep the two sets above honest.
 *
 * A hide that never answers ends in a close (see `hideNativeWebview`), and a
 * closed webview no longer exists — so it must leave `createdWebviews`, or the
 * next open would try to show something that is gone instead of creating it.
 */
async function takeWebviewOffScreen(label: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  const outcome = await hideNativeWebview(invoke, label)
  if (outcome === "hidden") return
  console.warn(`[WebView] hide did not confirm for ${label}; ${outcome}`)
  createdWebviews.delete(label)
  needsUrlReset.delete(label)
}

// Subscribe to tab store to hide native webviews when their tabs are closed
let tabCleanupInitialized = false
function initTabCleanup() {
  if (tabCleanupInitialized || !isTauri()) return
  tabCleanupInitialized = true

  let prevTabs = useTabsStore.getState().tabs

  useTabsStore.subscribe((state) => {
    const currTabs = state.tabs
    if (currTabs === prevTabs) return

    // Find removed webview tabs
    const currIds = new Set(currTabs.map((t) => t.id))
    const removed = prevTabs.filter((t) => t.type === "webview" && !currIds.has(t.id))

    for (const tab of removed) {
      const label = urlToLabel(normalizeUrl(tab.target))
      if (createdWebviews.has(label)) {
        // Hide instead of close to preserve login/session state.
        // Mark for URL reset so reopening navigates to the original URL.
        needsUrlReset.add(label)
        void takeWebviewOffScreen(label)
      }
    }

    prevTabs = currTabs
  })
}

export function WebViewContent({ url: rawUrl }: WebViewContentProps) {
  const { t } = useTranslation()
  const url = normalizeUrl(rawUrl)
  const label = urlToLabel(url)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(!createdWebviews.has(label))
  const [error, setError] = useState<string | null>(null)
  // Track last bounds to skip no-op repositions (prevents jitter)
  const lastBoundsRef = useRef<string>("")
  // Whether the native webview is currently placed over this container. It is
  // created parked off-window, so until something brings it on screen nothing
  // may move it there — a reposition would put a blank white webview on top of
  // the app, which is the thing we are avoiding.
  const onScreenRef = useRef(false)

  // Initialize global tab cleanup listener
  useEffect(() => { initTabCleanup() }, [])

  /** Place the native webview over this container, at its current bounds. */
  const bringOnScreen = useCallback(async () => {
    const el = containerRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
    lastBoundsRef.current = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("webview_show", { label, ...bounds })
      onScreenRef.current = true
    } catch {
      // A show that fails leaves it parked, which is the safe side.
    }
  }, [label])

  // Update native webview position/size to match container (debounced)
  const updateBounds = useCallback(async () => {
    const el = containerRef.current
    if (!el) return
    if (!onScreenRef.current) return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // Skip if bounds haven't changed (prevents jitter loop)
    const boundsKey = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`
    if (boundsKey === lastBoundsRef.current) return
    lastBoundsRef.current = boundsKey

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("webview_set_bounds", {
        label,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    } catch {
      // ignore resize errors
    }
  }, [label])

  useEffect(() => {
    if (!containerRef.current || !url) return
    if (!isTauri()) return

    setError(null)
    let cancelled = false

    // Measure container synchronously in RAF, then schedule async Tauri work
    // outside RAF to avoid blocking the main thread during webview creation.
    requestAnimationFrame(() => {
      if (cancelled || !containerRef.current) return

      const rect = containerRef.current.getBoundingClientRect()
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }

      // Schedule Tauri invocations off the animation frame
      setTimeout(async () => {
        if (cancelled) return

        try {
          const { invoke } = await import("@tauri-apps/api/core")
          const alreadyExists = createdWebviews.has(label)

          if (alreadyExists) {
            // Webview already exists — show and reposition
            setIsLoading(false)

            // If tab was closed and reopened, navigate back to the original URL
            if (needsUrlReset.has(label)) {
              needsUrlReset.delete(label)
              await invoke("webview_navigate", { label, url })
            }

            await invoke("webview_show", {
              label,
              ...bounds,
            })
            onScreenRef.current = true
          } else {
            // Create new native webview
            setIsLoading(true)

            // Identity injection is vestigial now: `window.teamclu.deviceToken`
            // is always null and the `get_persistent_device_id` command was
            // removed. Pass no deviceNo so the native side skips injecting the
            // (empty) identity script. Should it come back, the native side now
            // injects only into trusted origins (Cloud API host, the SSO-vetted
            // admin console, loopback) and never after a cross-origin navigation.
            const deviceNo: string | undefined = undefined

            // Device name is purely a display value and must NOT gate injection:
            // prefer cloud profile display name, fall back to hostname, accept empty if unavailable.
            let deviceName = ""
            try {
              const friendly = useCurrentTeamStore.getState().currentMember?.displayName ?? null
              deviceName = friendly || (await invoke<string>("get_device_hostname"))
            } catch {
              // Empty deviceName is acceptable; injection still happens.
            }

            // Partner admin console auto-login: for the allowlisted admin host,
            // hand the current TeamClu session to the native side so it seeds
            // the page's supabase-js localStorage before the bundle runs.
            const authInject = adminSsoInjectionFor(url)

            await invoke("webview_create", {
              label,
              url,
              x: bounds.x,
              y: bounds.y,
              width: Math.max(1, bounds.width),
              height: Math.max(1, bounds.height),
              deviceNo,
              deviceName,
              authStorageKey: authInject?.storageKey,
              authSessionJson: authInject?.sessionJson,
            })

            // Registered the moment it exists, mounted or not: this set is the
            // only handle anything has on the native webview, and a create that
            // finished after the switch away used to leave one nothing could
            // find — or hide.
            createdWebviews.add(label)
            onScreenRef.current = false
            // No timer hides the spinner here. The webview is parked off-window
            // until the page commits or the backend rules on it, and the effect
            // below acts on whichever arrives first. `webview-load-verdict`
            // always arrives, so this cannot wait forever.
          }

          // The view can change during any await above. The cleanup that ran
          // back then found nothing to hide — the webview did not exist yet —
          // and nothing else will come looking. A native webview is not part
          // of the React tree: left showing, it sits on top of whatever the
          // user switched to (the white page over the session) until the app
          // restarts.
          if (cancelled) {
            await takeWebviewOffScreen(label)
            return
          }

          // Deliberately no `lastBoundsRef` seeding: the webview is parked, not
          // at `bounds`, so recording them would let `updateBounds` skip the
          // first real reposition as a no-op.
        } catch (err) {
          console.error("[WebView] Failed:", err)
          if (!cancelled) {
            setError(
              err instanceof Error ? err.message : String(err || "Failed to create webview"),
            )
            setIsLoading(false)
          }
        }
      }, 0)
    })

    // Debounced resize observer to prevent jitter
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => updateBounds(), 100)
    })
    observer.observe(containerRef.current)

    return () => {
      cancelled = true
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      // Hide (don't close) the native webview when switching away
      if (createdWebviews.has(label)) {
        void takeWebviewOffScreen(label)
      }
    }
  }, [url, label, updateBounds])

  // Bring the parked webview on screen, or say why it never will.
  //
  // wry's navigation delegate implements `didCommitNavigation` and
  // `didFinishNavigation` only, so a page that fails to load fires no event at
  // all. That is why the backend also rules on every new webview after five
  // seconds (`spawn_load_watchdog`): between the two, exactly one of "it
  // loaded" and "it failed" always arrives.
  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    const unlisteners: Array<() => void> = []

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const onProgress = await listen<{ label: string; progress: number }>(
        "webview-progress",
        (event) => {
          if (cancelled || event.payload.label !== label) return
          // A progress event means the page committed, so whatever we decided
          // earlier about it failing is out of date.
          setError(null)
          setIsLoading(false)
          // Progress also fires on every later navigation; only the first one
          // has anything to fetch.
          if (!onScreenRef.current) void bringOnScreen()
        },
      )

      const onVerdict = await listen<{ label: string; state: string; reason: string | null }>(
        "webview-load-verdict",
        (event) => {
          if (cancelled || event.payload.label !== label) return
          setIsLoading(false)

          if (event.payload.state === "failed") {
            // Keep it parked. The error below is a DOM node, and a native child
            // webview draws above every DOM node — on screen it would cover the
            // very message explaining it.
            void takeWebviewOffScreen(label)
            onScreenRef.current = false
            setError(event.payload.reason || t("webview.loadFailed", "Failed to load page"))
            return
          }

          // "loaded" or "slow": show it either way. A slow page is still a page.
          void bringOnScreen()
        },
      )

      if (cancelled) {
        onProgress()
        onVerdict()
        return
      }
      unlisteners.push(onProgress, onVerdict)
    })

    return () => {
      cancelled = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [label, bringOnScreen, t])

  /** Error overlay's retry: reload the page and let the events above decide. */
  const retry = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("webview_navigate", { label, url })
    } catch (err) {
      setIsLoading(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [label, url])

  if (!isTauri()) {
    // Web fallback: use iframe
    return (
      <div className="relative w-full h-full pointer-events-auto">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        <iframe
          src={url}
          className="w-full h-full border-0"
          title={t('webview.iframeTitle', 'Web content')}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false)
            setError(t('webview.loadFailed', 'Failed to load page'))
          }}
        />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <div className="text-center text-muted-foreground">
              <p className="text-sm">{error}</p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open in browser
              </a>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Tauri: native webview renders on top; container is pointer-events-none
  // so mouse events pass through to the native webview underneath.
  // Loading/error overlays use pointer-events-auto to remain clickable.
  return (
    <div ref={containerRef} className="relative w-full h-full pointer-events-none">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 pointer-events-auto">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background pointer-events-auto">
          <div className="text-center text-muted-foreground">
            <p className="text-sm">{error}</p>
            <div className="flex items-center justify-center gap-3 mt-2">
              <button
                type="button"
                onClick={retry}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <RotateCw className="h-3 w-3" />
                {t('webview.retry', '重试')}
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t('webview.openInBrowser', '在浏览器中打开')}
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
