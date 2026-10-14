import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, AlertCircle, Clock, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { cn } from '@/lib/utils'
import { LocalAgentRequiredCard } from '@/components/daemon/LocalAgentRequiredCard'
import { useLocalAgentSectionGate } from '@/hooks/use-local-agent-install'
import { SectionHeader, SettingCard } from './shared'

function formatRelative(value: string | null): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return value
  const diff = Date.now() - time
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function statusClass(status: string): string {
  switch (status) {
    case 'running':
    case 'active':
      return 'bg-green-100 text-green-700'
    case 'starting':
      return 'bg-amber-100 text-amber-700'
    case 'failed':
      return 'bg-red-100 text-red-700'
    case 'idle':
      return 'bg-blue-100 text-blue-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

/**
 * One attached session, as the actor retain reports it.
 *
 * This section used to list `agent_runtimes` rows — one per spawn, accumulating
 * forever. It now lists live attachments, so a session that has gone cold
 * simply is not here (ADR-0004).
 */
type LiveEntry = ReturnType<typeof useRuntimeStateStore.getState>['byRuntimeId'][string]

type DaemonRuntime = {
  id: string
  runtimeId: string
  agentName: string
  status: string
  currentModel: string
  workspaceName: string
  sessionTitle: string
  lastSeenAt: string
}

function RuntimeCard({ runtime, liveState }: { runtime: DaemonRuntime; liveState: LiveEntry | undefined }) {
  const { t } = useTranslation()
  const liveInfo = liveState?.info
  const displayStatus = liveInfo?.state != null ? String(liveInfo.state) : runtime.status
  const displayModel = liveInfo?.currentModel || runtime.currentModel || '-'

  return (
    <div className="rounded-lg border border-border-soft bg-background/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-medium">{runtime.agentName}</p>
            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium', statusClass(runtime.status))}>
              {runtime.status}
            </span>
            {liveState && (
              <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                {t('settings.daemonRuntimes.live', 'Live')}
              </span>
            )}
          </div>
          <div className="mt-2 grid gap-1.5 text-xs sm:grid-cols-[112px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{t('settings.daemonRuntimes.runtimeId', 'Runtime ID')}</span>
            <code className="break-all font-mono text-foreground">{runtime.runtimeId || runtime.id}</code>
            <span className="text-muted-foreground">{t('settings.daemonRuntimes.model', 'Model')}</span>
            <code className="break-all font-mono text-foreground">{displayModel}</code>
            <span className="text-muted-foreground">{t('settings.daemonRuntimes.workspace', 'Workspace')}</span>
            <span className="min-w-0">
              <span className="block truncate text-foreground">{runtime.workspaceName || '-'}</span>
            </span>
            <span className="text-muted-foreground">{t('settings.daemonRuntimes.session', 'Session')}</span>
            <span className="truncate text-foreground">{runtime.sessionTitle || '-'}</span>
            <span className="text-muted-foreground">{t('settings.daemonRuntimes.liveState', 'Live state')}</span>
            <span className="font-mono text-foreground">{displayStatus}</span>
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <div className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelative(liveState ? new Date(liveState.lastUpdated).toISOString() : runtime.lastSeenAt)}
          </div>
        </div>
      </div>
    </div>
  )
}

export function DaemonRuntimesSection() {
  const gate = useLocalAgentSectionGate()
  if (gate === 'wait') return null
  if (gate === 'card') return <LocalAgentRequiredCard />
  return <DaemonRuntimesSectionBody />
}

function DaemonRuntimesSectionBody() {
  const { t } = useTranslation()
  const team = useCurrentTeamStore((s) => s.team)
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const [loading] = React.useState(false)
  const [error] = React.useState<string | null>(null)

  // Derived, not fetched: the retain already holds every live attachment, so
  // the refresh button has nothing to re-request.
  const runtimes: DaemonRuntime[] = React.useMemo(
    () =>
      Object.entries(runtimeStates).map(([key, entry]) => ({
        id: key,
        runtimeId: entry.info.runtimeId || key,
        agentName: entry.daemonActorId,
        status: entry.info.status != null ? String(entry.info.status) : '',
        currentModel: entry.info.currentModel || '',
        workspaceName: entry.info.workspaceId || '',
        sessionTitle: entry.info.sessionTitle || '',
        lastSeenAt: new Date(entry.lastUpdated).toISOString(),
      })),
    [runtimeStates],
  )

  const load = React.useCallback(async () => {}, [])

  if (!team) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Activity}
          title={t('settings.daemonRuntimes.title', 'Runtimes')}
          description={t('settings.daemonRuntimes.description', 'View current daemon runtimes')}
          iconColor="text-emerald-500"
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonRuntimes.noTeam', 'Join or create a team before viewing daemon runtimes.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          icon={Activity}
          title={t('settings.daemonRuntimes.title', 'Runtimes')}
          description={t('settings.daemonRuntimes.description', 'View current daemon runtimes')}
          iconColor="text-emerald-500"
        />
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      {error && (
        <SettingCard className="border-destructive/20 bg-destructive/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="text-[13px] font-medium text-destructive">{t('common.error', 'Error')}</p>
              <p className="mt-1 break-words text-[13px] text-destructive/80">{error}</p>
            </div>
          </div>
        </SettingCard>
      )}

      <SettingCard>
        {loading && runtimes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : runtimes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('settings.daemonRuntimes.empty', 'No runtimes reported yet.')}</p>
        ) : (
          <div className="space-y-2">
            {runtimes.map((runtime) => (
              <RuntimeCard
                key={runtime.id}
                runtime={runtime}
                liveState={runtime.runtimeId ? runtimeStates[runtime.runtimeId] : undefined}
              />
            ))}
          </div>
        )}
      </SettingCard>
    </div>
  )
}
