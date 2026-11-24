// Link shortcuts to a partner web console open already signed in.
//
// Before a link shortcut's tab is opened, ask the Cloud API for a one-time
// sign-in URL (POST /v1/auth/web-handoff). When it answers one, the webview is
// CREATED at that URL instead of the shortcut's own: the console's /session
// page verifies the one-time hash into a session of its own and lands on the
// shortcut's path. The tab keeps the shortcut's URL as its target, so the
// sidebar's active/open state and the webview label are unchanged.
//
// TeamClu's own tokens never reach the page (contrast admin-sso-inject.ts), so
// the console refreshes on its own token family and cannot log TeamClu out.
//
// Once per host per app run: external webviews share one persistent data store,
// so after the first handoff the console's session is simply there. Hosts the
// server declines are remembered too, so ordinary links cost one round trip per
// run, not one per click. A failed request is not remembered — the link opens
// as is and the next click asks again.

import { getBackend } from "@/lib/backend/provider"
import { normalizeUrl } from "@/lib/ui/webview-utils"

const HANDOFF_TIMEOUT_MS = 4000

/** Hosts already handled this run (handed off, or declined by the server). */
const settledHosts = new Set<string>()
/** normalized shortcut URL → the one-time URL its webview should be created at. */
const entryUrls = new Map<string, string>()
/** Requests in flight, per host, so a double click asks once. */
const inflight = new Map<string, Promise<void>>()

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? parsed.host.toLowerCase() : null
  } catch {
    return null
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("web handoff timed out")), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Resolve the handoff for a link shortcut about to open. Never throws: on any
 * failure the shortcut just opens at its own URL.
 */
export async function prepareWebHandoff(target: string): Promise<void> {
  const url = normalizeUrl(target)
  const host = hostOf(url)
  if (!host || settledHosts.has(host)) return
  const pending = inflight.get(host)
  if (pending) return pending
  const run = (async () => {
    try {
      const handoff = await withTimeout(getBackend().auth.webHandoffUrl(url), HANDOFF_TIMEOUT_MS)
      settledHosts.add(host)
      if (handoff) entryUrls.set(url, handoff)
    } catch {
      // Offline, signed out, or the server refused: open the link as is.
    } finally {
      inflight.delete(host)
    }
  })()
  inflight.set(host, run)
  return run
}

/**
 * The URL to create the webview for `url` at, consumed on read (a one-time hash
 * cannot be replayed). Null when there is no pending handoff for it.
 */
export function consumeWebviewEntryUrl(url: string): string | null {
  const key = normalizeUrl(url)
  const entry = entryUrls.get(key)
  if (!entry) return null
  entryUrls.delete(key)
  return entry
}

/** Test-only reset hook. */
export function resetWebHandoffForTests(): void {
  settledHosts.clear()
  entryUrls.clear()
  inflight.clear()
}
