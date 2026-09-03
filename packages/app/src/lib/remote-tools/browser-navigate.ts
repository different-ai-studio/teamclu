import { TOOL_NAVIGATE } from '@/lib/remote-tools/types'

type ChromeRuntimeLike = {
  sendMessage?: (msg: unknown) => Promise<unknown>
}

function readChromeRuntime(): ChromeRuntimeLike | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome?.runtime
}

export async function navigateActiveBrowserTab(url: string): Promise<void> {
  const runtime = readChromeRuntime()
  if (!runtime?.sendMessage) {
    throw new Error('chrome.runtime unavailable')
  }

  const resp = await runtime.sendMessage({
    type: 'browser-tool',
    tool: TOOL_NAVIGATE,
    url: url.trim(),
  })

  if (!resp || typeof resp !== 'object') {
    throw new Error('empty response from extension background')
  }
  const r = resp as { ok?: boolean; error?: string }
  if (r.error) {
    throw new Error(r.error)
  }
  if (!r.ok) {
    throw new Error('navigation failed')
  }
}
