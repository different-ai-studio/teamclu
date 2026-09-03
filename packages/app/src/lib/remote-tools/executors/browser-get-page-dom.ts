import { TOOL_GET_PAGE_DOM, type GetPageDomArgs, type GetPageDomResult } from '@/lib/remote-tools/types'

type ChromeRuntimeLike = {
  sendMessage?: (msg: unknown) => Promise<unknown>
  lastError?: { message?: string }
}

function readChromeRuntime(): ChromeRuntimeLike | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome?.runtime
}

export function createBrowserGetPageDomExecutor() {
  return async (args: Record<string, unknown>): Promise<GetPageDomResult> => {
    const runtime = readChromeRuntime()
    if (!runtime?.sendMessage) {
      throw new Error('chrome.runtime unavailable')
    }

    const mode = args.mode === 'text' ? 'text' : 'outline'
    const maxChars =
      typeof args.max_chars === 'number' && Number.isFinite(args.max_chars)
        ? Math.min(16_000, Math.max(1, Math.floor(args.max_chars)))
        : 8000

    const payload: GetPageDomArgs & { type: string; tool: string } = {
      type: 'browser-tool',
      tool: TOOL_GET_PAGE_DOM,
      mode,
      max_chars: maxChars,
    }

    const resp = await runtime.sendMessage(payload)
    if (!resp || typeof resp !== 'object') {
      throw new Error('empty response from extension background')
    }
    const r = resp as Partial<GetPageDomResult & { error?: string }>
    if (r.error) {
      throw new Error(r.error)
    }
    if (!r.url || !r.content) {
      throw new Error('invalid get_page_dom response')
    }
    return {
      url: r.url,
      title: r.title ?? '',
      mode: r.mode === 'text' ? 'text' : 'outline',
      content: r.content,
      truncated: Boolean(r.truncated),
    }
  }
}
