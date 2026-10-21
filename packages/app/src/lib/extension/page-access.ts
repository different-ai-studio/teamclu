import { create } from 'zustand'

/**
 * User consent for page access in the Chrome extension.
 *
 * Chrome Web Store review (and our own privacy policy) require that page
 * content leaves the browser only when the user chooses. An agent's
 * `get_page_dom` request used to read the active tab silently; it now waits for
 * the user to approve it in the side panel (once, or for the rest of this
 * panel session), and it can be switched off entirely in Settings.
 */

export const AGENT_PAGE_ACCESS_KEY = 'teamclu.extension.agentPageAccess'
export const EXTENSION_DIAGNOSTICS_KEY = 'teamclu.extension.diagnosticsOptIn'

/** How long an unanswered request waits before it is treated as denied. */
export const PAGE_ACCESS_REQUEST_TIMEOUT_MS = 120_000

export type AgentPageAccessMode = 'ask' | 'off'
export type PageAccessDecision = 'once' | 'session' | 'deny'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readAgentPageAccessMode(): AgentPageAccessMode {
  return storage()?.getItem(AGENT_PAGE_ACCESS_KEY) === 'off' ? 'off' : 'ask'
}

export function writeAgentPageAccessMode(mode: AgentPageAccessMode): void {
  storage()?.setItem(AGENT_PAGE_ACCESS_KEY, mode)
  if (mode === 'off') usePageAccessConsentStore.setState({ sessionAllowed: false })
}

/** Error reports (Sentry) from the extension are opt-in; default off. */
export function readExtensionDiagnosticsOptIn(): boolean {
  return storage()?.getItem(EXTENSION_DIAGNOSTICS_KEY) === '1'
}

export function writeExtensionDiagnosticsOptIn(enabled: boolean): void {
  storage()?.setItem(EXTENSION_DIAGNOSTICS_KEY, enabled ? '1' : '0')
}

interface PendingRequest {
  id: number
  resolve: (allowed: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface PageAccessConsentState {
  pending: PendingRequest | null
  /** "Allow for this session" — in memory only, cleared when the panel closes. */
  sessionAllowed: boolean
}

export const usePageAccessConsentStore = create<PageAccessConsentState>(() => ({
  pending: null,
  sessionAllowed: false,
}))

let nextId = 1

function settle(allowed: boolean, sessionAllowed?: boolean): void {
  const { pending } = usePageAccessConsentStore.getState()
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  usePageAccessConsentStore.setState((s) => ({
    pending: null,
    sessionAllowed: sessionAllowed ?? s.sessionAllowed,
  }))
  pending.resolve(allowed)
}

/**
 * Ask the user whether an agent may read the current page. Resolves false when
 * page access is switched off, the user declines, or nobody answers in time.
 */
export function requestAgentPageAccess(): Promise<boolean> {
  if (readAgentPageAccessMode() === 'off') return Promise.resolve(false)
  if (usePageAccessConsentStore.getState().sessionAllowed) return Promise.resolve(true)

  // A newer request supersedes an unanswered one.
  settle(false)

  return new Promise<boolean>((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => {
      if (usePageAccessConsentStore.getState().pending?.id === id) settle(false)
    }, PAGE_ACCESS_REQUEST_TIMEOUT_MS)
    usePageAccessConsentStore.setState({ pending: { id, resolve, timer } })
  })
}

export function resolveAgentPageAccess(decision: PageAccessDecision): void {
  if (decision === 'deny') {
    settle(false)
    return
  }
  settle(true, decision === 'session' ? true : undefined)
}

type ChromePermissionsLike = {
  request?: (p: { origins: string[] }) => Promise<boolean>
  contains?: (p: { origins: string[] }) => Promise<boolean>
}
type ChromeLike = {
  runtime?: { getManifest?: () => { optional_host_permissions?: string[]; content_scripts?: unknown[] } }
  permissions?: ChromePermissionsLike
}

function readChrome(): ChromeLike | undefined {
  return (globalThis as unknown as { chrome?: ChromeLike }).chrome
}

/** Optional host patterns this package can ask for (empty for domain-scoped brands). */
export function optionalHostPatterns(): string[] {
  return readChrome()?.runtime?.getManifest?.().optional_host_permissions ?? []
}

/** Whether the optional site access has already been granted. */
export async function hasOptionalHostAccess(origins = optionalHostPatterns()): Promise<boolean> {
  const perms = readChrome()?.permissions
  if (origins.length === 0 || !perms?.contains) return true
  try {
    return await perms.contains({ origins })
  } catch {
    return false
  }
}

/**
 * Ask Chrome for optional host access. MUST be called synchronously from a
 * click/keyboard handler (Chrome requires a user gesture); do not await
 * anything before it.
 */
export function requestOptionalHostAccess(origins = optionalHostPatterns()): Promise<boolean> {
  const perms = readChrome()?.permissions
  if (origins.length === 0 || !perms?.request) return Promise.resolve(true)
  return perms.request({ origins }).catch(() => false)
}

/** Host patterns covering one link-hover domain (apex + subdomains). */
export function linkHoverOriginsForDomain(domain: string): string[] {
  return [`http://*.${domain}/*`, `https://*.${domain}/*`]
}

/**
 * Packages with a static, brand-scoped content script already have the access
 * they need for link-hover; only the unbranded package asks per domain.
 */
export function linkHoverNeedsPermission(): boolean {
  const manifest = readChrome()?.runtime?.getManifest?.()
  if (!manifest) return false
  if ((manifest.content_scripts?.length ?? 0) > 0) return false
  return (manifest.optional_host_permissions?.length ?? 0) > 0
}
