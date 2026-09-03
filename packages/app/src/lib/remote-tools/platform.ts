import { capabilities } from '@/lib/config/platform'

import { registerExecutor } from '@/lib/remote-tools/registry'
import { TOOL_GET_PAGE_DOM } from '@/lib/remote-tools/types'
import { createBrowserGetPageDomExecutor } from '@/lib/remote-tools/executors/browser-get-page-dom'

let registered = false

export function registerPlatformExecutors(): void {
  if (registered) return
  registered = true

  if (capabilities.pageCapture) {
    registerExecutor(TOOL_GET_PAGE_DOM, createBrowserGetPageDomExecutor())
  }
}

/** Test helper — reset registration gate. */
export function resetPlatformExecutorsForTests(): void {
  registered = false
}
