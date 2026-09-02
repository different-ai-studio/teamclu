import { emitComposerInsert } from './embed-composer-bus'

export type PageContext = { title: string; url: string; text: string; selection: string }

export function formatPageContext(ctx: PageContext): string {
  const rawBody = ctx.selection.trim() || ctx.text.trim()
  const body = rawBody.length > 4000 ? `${rawBody.slice(0, 3997)}...` : rawBody
  const header = ctx.title ? `【${ctx.title}】` : ''
  return `${header}\n${ctx.url}\n\n${body}`.trim()
}

type ChromeLike = {
  runtime?: {
    onMessage?: {
      addListener: (h: (m: unknown) => void) => void
      removeListener: (h: (m: unknown) => void) => void
    }
    sendMessage?: (msg: unknown) => Promise<unknown>
  }
  storage?: {
    session?: {
      get: (key: string) => Promise<Record<string, unknown>>
      remove: (key: string) => Promise<void>
      onChanged?: {
        addListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
        removeListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
      }
    }
  }
}

export const PENDING_LINK_CONTEXT_KEY = 'teamclu.pendingLinkContext'

function readChrome(): ChromeLike | undefined {
  return (globalThis as unknown as { chrome?: ChromeLike }).chrome
}

export function isPageContextPayload(payload: unknown): payload is PageContext {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as PageContext
  return typeof p.url === 'string' && typeof p.text === 'string' && typeof p.title === 'string'
}

function isPageContextMessage(m: unknown): m is { type: 'page-context'; payload: PageContext } {
  return (
    typeof m === 'object' && m !== null &&
    (m as { type?: unknown }).type === 'page-context' &&
    typeof (m as { payload?: unknown }).payload === 'object'
  )
}

/**
 * Request a page capture from the extension background via request/response.
 * This is the PRIMARY path. No-op when not running inside an extension.
 */
export async function requestPageCapture(): Promise<void> {
  const c = readChrome()?.runtime
  if (!c?.sendMessage) return
  try {
    const resp = await c.sendMessage({ type: 'request-page' })
    if (isPageContextMessage(resp)) {
      emitComposerInsert(formatPageContext(resp.payload))
    }
  } catch (e) {
    console.warn('[embed] page capture failed', e)
  }
}

/** Consume a link context stashed by the content-script hover affordance. */
export async function consumePendingLinkContext(): Promise<void> {
  const storage = readChrome()?.storage?.session
  if (!storage) return
  try {
    const bag = await storage.get(PENDING_LINK_CONTEXT_KEY)
    const payload = bag[PENDING_LINK_CONTEXT_KEY]
    if (!isPageContextPayload(payload)) return
    await storage.remove(PENDING_LINK_CONTEXT_KEY)
    emitComposerInsert(formatPageContext(payload))
  } catch (e) {
    console.warn('[embed] pending link context failed', e)
  }
}

/** Listen for page-context messages from the extension and inject into the composer.
 *  No-op (returns a cleanup fn) when not running inside an extension (no chrome.runtime).
 *  Note: the primary capture path is requestPageCapture() via request/response.
 *  This listener remains as a dormant secondary push channel. */
export function startEmbedPageContextListener(): () => void {
  const chromeApi = readChrome()
  const onMessage = chromeApi?.runtime?.onMessage
  const session = chromeApi?.storage?.session

  const onSessionChanged = (changes: Record<string, { newValue?: unknown }>) => {
    if (changes[PENDING_LINK_CONTEXT_KEY]?.newValue) {
      void consumePendingLinkContext()
    }
  }

  if (session?.onChanged) {
    session.onChanged.addListener(onSessionChanged)
  }

  if (!onMessage) {
    return () => {
      session?.onChanged?.removeListener(onSessionChanged)
    }
  }

  const handler = (m: unknown) => {
    if (isPageContextMessage(m)) emitComposerInsert(formatPageContext(m.payload))
  }
  onMessage.addListener(handler)
  return () => {
    onMessage.removeListener(handler)
    session?.onChanged?.removeListener(onSessionChanged)
  }
}
