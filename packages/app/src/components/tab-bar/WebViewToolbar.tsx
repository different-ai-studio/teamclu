import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, ArrowRight, RotateCw, Lock } from "lucide-react"
import { cn, isTauri } from "@/lib/utils"
import { normalizeUrl } from "@/lib/ui/webview-utils"
import { useTabsStore } from "@/stores/tabs"

interface WebViewToolbarProps {
  /** The original URL from the tab target */
  url: string
  /** Stable webview label for invoking Rust commands */
  label: string
  /** Current zoom level (1.0 = 100%) */
  zoomLevel?: number
}

export function WebViewToolbar({ url: rawUrl, label, zoomLevel }: WebViewToolbarProps) {
  const { t } = useTranslation()
  const url = normalizeUrl(rawUrl)
  const [address, setAddress] = useState({ label, target: url, value: url })
  // A reused toolbar must never render the previous webview's address.
  const currentUrl = address.label === label && address.target === url ? address.value : url
  const [progress, setProgress] = useState(0)
  const [showProgress, setShowProgress] = useState(false)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Navigation events refresh the address immediately; polling remains a
  // fallback for in-page history changes that do not trigger a page load.
  useEffect(() => {
    setAddress({ label, target: url, value: url })
    setProgress(0)
    setShowProgress(false)
    if (!isTauri()) return

    let cancelled = false
    let unlisten: (() => void) | null = null
    let addressRequest = 0
    let pendingAddresses = 0
    let metadataRequest = 0

    const refreshAddress = async (navigation = false) => {
      // A timer must not invalidate a slower lookup. Navigation may supersede it.
      if (!navigation && pendingAddresses > 0) return
      pendingAddresses++
      const request = ++addressRequest
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        if (cancelled) return
        const value = await invoke<string>("webview_get_url", { label })
        if (!cancelled && request === addressRequest && value) {
          setAddress(previous => previous.label === label && previous.target === url && previous.value === value
            ? previous : { label, target: url, value })
        }
      } catch {
        // The webview may not exist yet. A navigation event or poll retries.
      } finally {
        pendingAddresses--
      }
    }

    const refreshMetadata = async () => {
      const request = ++metadataRequest
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        if (cancelled) return
        const [title, faviconUrl] = await Promise.all([
          invoke<string>("webview_get_title", { label }).catch(() => ""),
          invoke<string>("webview_get_favicon", { label }).catch(() => ""),
        ])
        if (cancelled || request !== metadataRequest) return
        const meta: { title?: string; faviconUrl?: string } = {}
        if (title) meta.title = title
        if (faviconUrl) meta.faviconUrl = faviconUrl
        if (meta.title || meta.faviconUrl) {
          useTabsStore.getState().updateTabMeta(rawUrl, meta)
        }
      } catch {
        // Metadata must not hold up the address bar.
      }
    }

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      if (cancelled) return
      const dispose = await listen<{ label: string; progress: number }>("webview-progress", (event) => {
        if (cancelled || event.payload.label !== label) return
        void refreshAddress(true)
        const p = event.payload.progress
        setProgress(p)
        if (fadeTimerRef.current !== null) {
          clearTimeout(fadeTimerRef.current)
          fadeTimerRef.current = null
        }
        if (p < 100) {
          setShowProgress(true)
        } else {
          void refreshMetadata()
          fadeTimerRef.current = setTimeout(() => {
            setShowProgress(false)
            fadeTimerRef.current = null
          }, 300)
        }
      })
      if (cancelled) dispose()
      else unlisten = dispose
    }).catch(() => {})

    const refresh = () => {
      void refreshAddress()
      void refreshMetadata()
    }
    refresh()
    const addressInterval = setInterval(() => { void refreshAddress() }, 250)
    const metadataInterval = setInterval(() => { void refreshMetadata() }, 2000)

    return () => {
      cancelled = true
      clearInterval(addressInterval)
      clearInterval(metadataInterval)
      unlisten?.()
      if (fadeTimerRef.current !== null) {
        clearTimeout(fadeTimerRef.current)
        fadeTimerRef.current = null
      }
    }
  }, [label, url, rawUrl])

  const invokeWebview = useCallback(async (command: string) => {
    if (!isTauri()) return
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke(command, { label }).catch(() => {})
  }, [label])

  const goBack = useCallback(() => invokeWebview("webview_go_back"), [invokeWebview])
  const goForward = useCallback(() => invokeWebview("webview_go_forward"), [invokeWebview])
  const reload = useCallback(() => invokeWebview("webview_reload"), [invokeWebview])

  const isHttps = currentUrl.startsWith("https://")
  // Strip protocol for display
  const displayUrl = currentUrl.replace(/^https?:\/\//, "")

  return (
    <div className="relative flex flex-col shrink-0 pointer-events-auto">
      {showProgress && (
        <div className="absolute top-0 left-0 right-0 h-0.5 z-10">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/30">
        {/* Navigation buttons */}
        <NavButton onClick={goBack} title={t("webview.back")}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton onClick={goForward} title={t("webview.forward")}>
          <ArrowRight className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton onClick={reload} title={t("webview.reload")}>
          <RotateCw className="h-3.5 w-3.5" />
        </NavButton>

        {/* Address bar (read-only) */}
        <div className="flex-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background/80 border text-xs text-muted-foreground min-w-0 ml-1">
          {isHttps && <Lock className="h-3 w-3 shrink-0 text-green-600" />}
          <span className="truncate select-text">{displayUrl}</span>
        </div>

        {zoomLevel != null && zoomLevel !== 1.0 && (
          <span className="text-[10px] text-muted-foreground shrink-0 px-1">
            {Math.round(zoomLevel * 100)}%
          </span>
        )}
      </div>
    </div>
  )
}

function NavButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "p-1.5 rounded-md text-muted-foreground",
        "hover:bg-muted hover:text-foreground",
        "transition-colors duration-150",
      )}
    >
      {children}
    </button>
  )
}
