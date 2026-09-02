import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, ExternalLink } from "lucide-react"
import { isTauri } from "@/lib/utils"
import { normalizeUrl, urlToLabel } from "@/lib/webview-utils"
import { useTabsStore } from "@/stores/tabs"
import { useCurrentTeamStore } from "@/stores/current-team"
import { adminSsoInjectionFor } from "@/lib/admin-sso-inject"

interface WebViewContentProps {
  url: string
}

// Track which webview labels have been created (globally, survives component unmount)
const createdWebviews = new Set<string>()
// Track webviews whose tabs were closed — need URL reset when reopened
const needsUrlReset = new Set<string>()

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
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_hide", { label }).catch(() => {})
        })
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

  // Initialize global tab cleanup listener
  useEffect(() => { initTabCleanup() }, [])

  // Update native webview position/size to match container (debounced)
  const updateBounds = useCallback(async () => {
    const el = containerRef.current
    if (!el) return

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

            if (!cancelled) {
              createdWebviews.add(label)
              setTimeout(() => {
                if (!cancelled) setIsLoading(false)
              }, 1500)
            }
          }

          // Record initial bounds
          lastBoundsRef.current = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
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
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_hide", { label }).catch(() => {})
        })
      }
    }
  }, [url, label, updateBounds])

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
