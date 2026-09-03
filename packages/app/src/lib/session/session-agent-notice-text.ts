import type { TFunction } from 'i18next'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'

export function buildPostSendSessionNotice(
  entries: EngagedAgentUiEntry[],
  t: TFunction,
): string | null {
  const offline = entries.filter((e) => e.uiState === 'offline')
  const stale = entries.filter((e) => e.uiState === 'stale')
  const runtimeErrors = entries.filter((e) => e.uiState === 'runtime-error')
  if (offline.length === 0 && stale.length === 0 && runtimeErrors.length === 0) return null

  if (runtimeErrors.length > 0) {
    if (offline.length > 0 || stale.length > 0) {
      return t('chat.sessionNotice.sentUnavailableMixed', {
        runtimeErrorCount: runtimeErrors.length,
        offlineCount: offline.length,
        staleCount: stale.length,
      })
    }
    const names = runtimeErrors.map((e) => e.agent.displayName).join('、')
    return runtimeErrors.length === 1
      ? t('chat.sessionNotice.sentRuntimeErrorOne', { name: names })
      : t('chat.sessionNotice.sentRuntimeErrorMany', { count: runtimeErrors.length })
  }

  if (stale.length > 0 && offline.length > 0) {
    return t('chat.sessionNotice.sentMixed', {
      staleCount: stale.length,
      offlineCount: offline.length,
    })
  }

  if (stale.length > 0 && offline.length === 0) {
    const names = stale.map((e) => e.agent.displayName).join('、')
    if (stale.length === 1) {
      return t('chat.sessionNotice.sentStaleOne', { name: names })
    }
    return t('chat.sessionNotice.sentStaleMany', { count: stale.length })
  }

  const names = offline.map((e) => e.agent.displayName).join('、')
  if (offline.length === 1) {
    return t('chat.sessionNotice.sentOfflineOne', { name: names })
  }
  return t('chat.sessionNotice.sentOfflineMany', { count: offline.length })
}
