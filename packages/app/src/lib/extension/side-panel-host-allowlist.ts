/**
 * Build-time side-panel host allowlist for the Chrome extension.
 * Empty list = no gate (panel usable on any site).
 *
 * Patterns come from `extensions.domains` in build.config*.json
 * (e.g. `example.com`, `*.example.com`).
 */

export const SIDE_PANEL_HOST_GATE_STORAGE_KEY = 'teamclu.sidePanelHostGate'

export type SidePanelHostGateSnapshot = {
  allowed: boolean
  url: string | null
}

export function parseSidePanelDomainPatterns(
  raw: string | undefined | null,
): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
}

export function isSidePanelHostGateEnabled(
  patterns: readonly string[],
): boolean {
  return patterns.length > 0
}

/** Always allow the extension management page so users can configure domains. */
export function isChromeExtensionsPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'chrome:' && parsed.hostname === 'extensions'
  } catch {
    return false
  }
}

/**
 * Match hostname against allowlist patterns.
 * `*.example.com` also allows the apex `example.com`.
 */
export function isHostnameAllowedByPatterns(
  hostname: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return true
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return false

  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2)
      if (!base) continue
      if (host === base || host.endsWith(`.${base}`)) return true
      continue
    }
    if (host === pattern) return true
  }
  return false
}

export function isUrlAllowedBySidePanelPatterns(
  url: string | undefined | null,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return true
  if (!url) return false
  if (isChromeExtensionsPageUrl(url)) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isHostnameAllowedByPatterns(parsed.hostname, patterns)
  } catch {
    return false
  }
}
