import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import type { SessionAgentUiState, SessionAgentSyncHint } from '@/lib/session-agent-ui-state'

type Props = {
  entries: EngagedAgentUiEntry[]
  localDaemonAgent: AttachedAgent | null
  onRemoveAgent: (agentId: string) => void
  onSwitchToLocalAgent?: (agent: AttachedAgent) => void
  onRetryOffline?: () => void
  agentMentionLocked?: boolean
}

function filterActionable(entries: EngagedAgentUiEntry[]): EngagedAgentUiEntry[] {
  return entries.filter((e) =>
    e.uiState === 'offline' || e.uiState === 'stale' || e.uiState === 'runtime-error')
}

function bannerMessage(
  actionable: EngagedAgentUiEntry[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const stale = actionable.filter((e) => e.uiState === 'stale')
  const offline = actionable.filter((e) => e.uiState === 'offline')
  const runtimeErrors = actionable.filter((e) => e.uiState === 'runtime-error')
  if (runtimeErrors.length > 0 && runtimeErrors.length === actionable.length) {
    const names = runtimeErrors.map((e) => e.agent.displayName).join('、')
    return runtimeErrors.length === 1
      ? t('chat.sessionAgent.bannerRuntimeErrorOne', { name: names })
      : t('chat.sessionAgent.bannerRuntimeErrorMany', { count: runtimeErrors.length })
  }
  if (runtimeErrors.length > 0) {
    return t('chat.sessionAgent.bannerUnavailableMixed', { count: actionable.length })
  }

  if (stale.length > 0 && offline.length > 0) {
    return t('chat.sessionAgent.bannerMixed', {
      staleCount: stale.length,
      offlineCount: offline.length,
    })
  }
  if (actionable.length === 1) {
    const name = actionable[0].agent.displayName
    return actionable[0].uiState === 'stale'
      ? t('chat.sessionAgent.bannerStaleOne', { name })
      : t('chat.sessionAgent.bannerOfflineOne', { name })
  }
  if (stale.length > 0 && offline.length === 0) {
    return t('chat.sessionAgent.bannerStaleMany', { count: stale.length })
  }
  return t('chat.sessionAgent.bannerOfflineMany', { count: actionable.length })
}

export function EngagedAgentOfflineBanner({
  entries,
  localDaemonAgent,
  onRemoveAgent,
  onSwitchToLocalAgent,
  onRetryOffline,
  agentMentionLocked = false,
}: Props) {
  const { t } = useTranslation()
  const actionable = filterActionable(entries)
  if (actionable.length === 0) return null

  const hasStale = actionable.some((e) => e.uiState === 'stale')
  const hasOffline = actionable.some((e) => e.uiState === 'offline')
  const hasRuntimeError = actionable.some((e) => e.uiState === 'runtime-error')
  const showSwitch =
    !!localDaemonAgent &&
    !!onSwitchToLocalAgent &&
    (hasStale || actionable.length > 0)
  const showRetry = (hasOffline || hasRuntimeError) && !!onRetryOffline

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft px-3 py-2 text-[12px] text-muted-foreground"
      data-testid="engaged-agent-offline-banner"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1">{bannerMessage(actionable, t)}</span>
      <span className="flex shrink-0 items-center gap-2">
        {showRetry ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={onRetryOffline}
          >
            {t('chat.sessionAgent.retryConnection', 'Retry connection')}
          </button>
        ) : null}
        {showSwitch && localDaemonAgent ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => onSwitchToLocalAgent(localDaemonAgent)}
          >
            {t('chat.sessionAgent.switchToLocal')}
          </button>
        ) : null}
        {agentMentionLocked ? null : actionable.length === 1 ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => onRemoveAgent(actionable[0].agent.id)}
          >
            {t('chat.sessionAgent.removeMention')}
          </button>
        ) : (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => {
              for (const e of actionable) onRemoveAgent(e.agent.id)
            }}
          >
            {t('chat.sessionAgent.removeAllOffline')}
          </button>
        )}
      </span>
    </div>
  )
}

export function pillSuffixForUiState(
  uiState: SessionAgentUiState,
  t: (key: string, fallback: string) => string,
): string | null {
  switch (uiState) {
    case 'offline':
      return t('chat.sessionAgent.pillOffline', 'Offline')
    case 'stale':
      return t('chat.sessionAgent.pillStale', 'Rebind required')
    case 'connecting':
      return t('chat.sessionAgent.pillConnecting', 'Connecting…')
    case 'unconfigured':
      // Reachable, just has nothing to run — say so instead of implying a wait
      // ("Connecting…") or a network problem ("Offline").
      return t('chat.sessionAgent.pillUnconfigured', 'No model configured')
    case 'catalog-error':
      // Reachable, and could not be asked what it can run. Distinct from
      // `unconfigured` because that one tells the user to go configure a model,
      // which is the wrong errand for a rejected key or a broken binary.
      return t('chat.sessionAgent.pillCatalogError', 'Model list unavailable')
    case 'runtime-error':
      return t('chat.sessionAgent.pillRuntimeError', 'Agent start failed')
    default:
      return null
  }
}

export function pillSuffixForAgentPill(
  uiState: SessionAgentUiState,
  syncHint: SessionAgentSyncHint,
  t: (key: string, fallback: string) => string,
): string | null {
  const hardFailure = pillSuffixForUiState(uiState, t)
  if (hardFailure !== null) return hardFailure
  if (syncHint === 'degraded') {
    return t('chat.sessionAgent.pillSyncDegraded', 'Team sync interrupted')
  }
  return null
}
