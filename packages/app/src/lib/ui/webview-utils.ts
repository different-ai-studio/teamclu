import { getCurrentWindow } from "@tauri-apps/api/window"

/** Ensure URL has a protocol prefix */
export function normalizeUrl(url: string): string {
  if (!url) return url
  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`
  }
  return url
}

function sanitizeLabelPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_")
}

function getCurrentWindowLabel(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return "main"
  }
}

/**
 * Generate a stable, deterministic label from the URL.
 * Scope labels to the current Tauri window so the same URL opened in two
 * windows does not alias the same native child webview.
 */
export function urlToLabel(url: string, windowLabel = getCurrentWindowLabel()): string {
  const scopedWindowLabel = sanitizeLabelPart(windowLabel).slice(0, 24)
  const scopedUrl = sanitizeLabelPart(normalizeUrl(url)).slice(0, 60)
  return `wv-${scopedWindowLabel}-${scopedUrl}`
}
