import { clsx, type ClassValue } from "clsx"
import { toast } from 'sonner'
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isTauri() {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI__: unknown }).__TAURI__
  )
}

/**
 * Tear down the static `#skeleton` loading shell (see index.html). Idempotent —
 * safe to call from multiple hand-off points. The skeleton mirrors the real
 * three-column shell and stays up through every pure-loading startup gate; it is
 * removed only at the moment real or interactive UI is about to paint, so the
 * hand-off to React is seamless instead of flashing a blank background.
 */
export function removeStartupSkeleton(): void {
  if (typeof document === "undefined") return
  document.getElementById("skeleton")?.remove()
}

export async function copyToClipboard(text: string, _successMessage?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    toast.error('Failed to copy')
  }
}

// SEC-11: `shell.open` is configured wide open in tauri.conf.json, so this is
// the only scheme check between a content-controlled string and the OS handler
// for it (`file:`, `javascript:`, custom app schemes…).
const EXTERNAL_URL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"])

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_URL_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    console.warn("[openExternalUrl] refused: only http(s) and mailto links open externally")
    return
  }
  // Browser / extension builds have no shell plugin; a same-scheme window.open
  // with no opener is the whole capability there. Under Tauri there is no such
  // fallback: a failed shell.open is reported, not retried through the webview.
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer")
    return
  }
  try {
    const { open } = await import("@tauri-apps/plugin-shell")
    await open(url)
  } catch (err) {
    console.warn("[openExternalUrl] shell.open failed", err)
  }
}

/**
 * Shortens long paths or tokens for compact UI (e.g. "Always allow '…'").
 * Middle ellipsis keeps the start and end readable. Full value should be
 * shown via a title/tooltip when needed.
 */
export function truncatePermissionSnippet(text: string, maxLength = 40): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length <= maxLength) {
    return trimmed
  }
  const ellipsis = "…"
  const budget = maxLength - ellipsis.length
  if (budget < 4) {
    return `${trimmed.slice(0, Math.max(0, budget))}${ellipsis}`
  }
  const headChars = Math.ceil(budget / 2)
  const tailChars = Math.floor(budget / 2)
  return `${trimmed.slice(0, headChars)}${ellipsis}${trimmed.slice(-tailChars)}`
}
