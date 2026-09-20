import { extensionAgentReplyForkEnabled } from '@/lib/config/build-config'

/**
 * Agent-reply thread fork (`extensions.agentReplyFork` in build.config*.json).
 * Desktop / Tauri builds always keep fork enabled; only the extension embed
 * side panel (`VITE_FORCE_EMBED=chat`) respects the baked flag.
 */
export function isAgentReplyForkEnabled(): boolean {
  if (import.meta.env.VITE_FORCE_EMBED !== 'chat') return true
  return extensionAgentReplyForkEnabled
}
