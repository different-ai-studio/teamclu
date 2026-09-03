/** chrome.storage.local key for link-hover domain allowlist. */
export const LINK_HOVER_CONFIG_KEY = 'teamclu.extension.linkHover'

export interface LinkHoverConfig {
  domains: string[]
  /** Glob URL patterns (`*` = any chars). Empty = all http(s) links. */
  urlPatterns: string[]
}

export const DEFAULT_LINK_HOVER_CONFIG: LinkHoverConfig = {
  domains: [],
  urlPatterns: [],
}

const DOMAIN_LABEL =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

const URL_PATTERN_MAX_LEN = 2048

/** Normalize user input to a hostname label (no protocol, path, or port). */
export function normalizeDomainEntry(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null

  value = value.replace(/^https?:\/\//, '')
  value = value.split('/')[0]?.split('?')[0]?.split('#')[0] ?? ''
  value = value.split(':')[0] ?? ''
  value = value.replace(/\.$/, '')
  if (value.startsWith('www.')) {
    value = value.slice(4)
  }

  if (!value || !value.includes('.') || !DOMAIN_LABEL.test(value)) return null
  return value
}

export function isHostAllowed(hostname: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false

  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return false

  for (const entry of domains) {
    const pattern = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    if (!pattern) continue
    if (host === pattern) return true
    if (host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/** Trim + length-check a `*`-glob URL pattern. */
export function normalizeUrlPattern(raw: string): string | null {
  const value = raw.trim()
  if (!value || value.length > URL_PATTERN_MAX_LEN) return null
  return value
}

/**
 * Match a URL against a glob where `*` means any characters (including `/`).
 * Matching is case-insensitive; the whole URL must match (`^…$`).
 */
export function matchUrlGlob(url: string, pattern: string): boolean {
  const needle = url.trim()
  const glob = pattern.trim()
  if (!needle || !glob) return false

  let reSource = ''
  for (const ch of glob) {
    if (ch === '*') {
      reSource += '.*'
      continue
    }
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      reSource += `\\${ch}`
      continue
    }
    reSource += ch
  }

  try {
    return new RegExp(`^${reSource}$`, 'i').test(needle)
  } catch {
    return false
  }
}

/** Empty patterns → allow all (backward compatible). Otherwise any pattern may match. */
export function isLinkUrlAllowed(url: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true
  const href = url.trim()
  if (!href) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    if (matchUrlGlob(href, pattern)) return true
  }
  return false
}

export function parseLinkHoverConfig(raw: unknown): LinkHoverConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_LINK_HOVER_CONFIG, domains: [], urlPatterns: [] }
  }

  const domainsRaw = (raw as { domains?: unknown }).domains
  const patternsRaw = (raw as { urlPatterns?: unknown }).urlPatterns

  const seenDomains = new Set<string>()
  const domains: string[] = []
  if (Array.isArray(domainsRaw)) {
    for (const item of domainsRaw) {
      if (typeof item !== 'string') continue
      const normalized = normalizeDomainEntry(item)
      if (!normalized || seenDomains.has(normalized)) continue
      seenDomains.add(normalized)
      domains.push(normalized)
    }
  }

  const seenPatterns = new Set<string>()
  const urlPatterns: string[] = []
  if (Array.isArray(patternsRaw)) {
    for (const item of patternsRaw) {
      if (typeof item !== 'string') continue
      const normalized = normalizeUrlPattern(item)
      if (!normalized || seenPatterns.has(normalized)) continue
      seenPatterns.add(normalized)
      urlPatterns.push(normalized)
    }
  }

  return { domains, urlPatterns }
}

export function isLinkHoverEnabledForHost(
  hostname: string,
  config: LinkHoverConfig,
): boolean {
  return isHostAllowed(hostname, config.domains)
}

export function addDomainToConfig(
  config: LinkHoverConfig,
  raw: string,
): { ok: true; config: LinkHoverConfig } | { ok: false; error: 'invalid' | 'duplicate' } {
  const normalized = normalizeDomainEntry(raw)
  if (!normalized) return { ok: false, error: 'invalid' }
  if (config.domains.includes(normalized)) return { ok: false, error: 'duplicate' }
  return {
    ok: true,
    config: { ...config, domains: [...config.domains, normalized] },
  }
}

export function removeDomainFromConfig(
  config: LinkHoverConfig,
  domain: string,
): LinkHoverConfig {
  const target = domain.trim().toLowerCase()
  return {
    ...config,
    domains: config.domains.filter((d) => d !== target),
  }
}

export function addUrlPatternToConfig(
  config: LinkHoverConfig,
  raw: string,
): { ok: true; config: LinkHoverConfig } | { ok: false; error: 'invalid' | 'duplicate' } {
  const normalized = normalizeUrlPattern(raw)
  if (!normalized) return { ok: false, error: 'invalid' }
  if (config.urlPatterns.includes(normalized)) return { ok: false, error: 'duplicate' }
  return {
    ok: true,
    config: { ...config, urlPatterns: [...config.urlPatterns, normalized] },
  }
}

export function removeUrlPatternFromConfig(
  config: LinkHoverConfig,
  pattern: string,
): LinkHoverConfig {
  const target = pattern.trim()
  return {
    ...config,
    urlPatterns: config.urlPatterns.filter((p) => p !== target),
  }
}
