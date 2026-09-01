import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Users, CircleDot, Settings, RefreshCw, Cpu, Terminal } from 'lucide-react'
import { useTeamPermissions } from '@/lib/team-permissions'
import { TeamSharedLlmPane } from './llm/TeamSharedLlmPane'
import type { LlmModelEntry } from './team/HostLlmConfig'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getDaemonLocalAgent, type DaemonLocalAgent } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader } from './shared'

/**
 * Team-shared LLM settings — its own page, independent of the per-agent LLM
 * pane. The team-shared model proxy (cloud-stored `provider.team`) is reused by
 * whatever local agent is active, so this surface also shows the current
 * runtime (opencode / pi). Owner-only editing via the TeamSharedLlmPane dialog.
 */
export function TeamLlmSection() {
  const { t } = useTranslation()
  const { isOwner: isTeamOwner } = useTeamPermissions()
  const [teamSharedLlmOpen, setTeamSharedLlmOpen] = React.useState(false)
  const [teamSharedModel, setTeamSharedModel] = React.useState<{
    baseUrl: string
    models: LlmModelEntry[]
  } | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [localAgent, setLocalAgent] = React.useState<DaemonLocalAgent | null>(null)

  const loadTeamSharedModel = React.useCallback(async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) {
      setTeamSharedModel(null)
      return
    }
    try {
      // Cloud is the source of truth (`GET /v1/teams/:id/workspace-config` → `llm`).
      const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
      setTeamSharedModel(
        llm && llm.enabled && llm.baseUrl
          ? {
              baseUrl: llm.baseUrl,
              models: llm.models,
            }
          : null,
      )
    } catch {
      setTeamSharedModel(null)
    }
  }, [])

  React.useEffect(() => {
    void loadTeamSharedModel()
  }, [loadTeamSharedModel])

  React.useEffect(() => {
    if (!isTauri()) {
      setLocalAgent('opencode')
      return
    }
    let alive = true
    void getDaemonLocalAgent()
      .then((a) => {
        if (alive) setLocalAgent(a)
      })
      .catch(() => {
        if (alive) setLocalAgent('opencode')
      })
    return () => {
      alive = false
    }
  }, [])

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await loadTeamSharedModel()
      if (isTauri()) {
        try {
          setLocalAgent(await getDaemonLocalAgent())
        } catch {
          /* keep prior value */
        }
      }
    } finally {
      setRefreshing(false)
    }
  }, [loadTeamSharedModel])

  const AgentIcon = localAgent === 'pi' ? Cpu : Terminal

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <SectionHeader
          icon={Users}
          title={t('settings.teamLlmSection.title', '团队共享模型')}
          description={t(
            'settings.teamLlmSection.description',
            '团队共享的 AI 模型代理，供所有 local agent 复用。',
          )}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="h-8 shrink-0 gap-1.5 text-xs text-muted-foreground"
          title={t('settings.teamLlmSection.refreshTooltip', 'Refresh team-shared model')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          {refreshing
            ? t('settings.llm.refreshing', 'Refreshing...')
            : t('settings.llm.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Current runtime — the local agent that will consume the team model. */}
      <SettingCard className="!p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t('settings.teamLlmSection.currentRuntime', '当前 Agent 运行时')}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2.5 py-1 font-mono text-[12px] text-foreground">
            <AgentIcon className="h-3.5 w-3.5" />
            {localAgent ?? '…'}
          </span>
        </div>
      </SettingCard>

      {isTeamOwner && (
        <TeamSharedLlmPane
          open={teamSharedLlmOpen}
          onOpenChange={setTeamSharedLlmOpen}
          onSaved={loadTeamSharedModel}
        />
      )}

      {teamSharedModel ? (
        <SettingCard
          className={cn(
            '!p-3 border-primary/40 bg-primary/5',
            isTeamOwner && 'cursor-pointer hover:border-primary/60 transition-all',
          )}
        >
          <div
            className="flex items-center justify-between"
            onClick={isTeamOwner ? () => setTeamSharedLlmOpen(true) : undefined}
          >
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-md flex items-center justify-center bg-primary/15 text-primary">
                <Users className="h-3.5 w-3.5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium">
                    {teamSharedModel.models[0]?.name || teamSharedModel.models[0]?.id}
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    <Users className="h-2.5 w-2.5" />
                    {t('settings.llm.teamSharedBadge', '团队共享')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {teamSharedModel.models.length > 0
                    ? t('settings.llm.modelsAvailable', {
                        count: teamSharedModel.models.length,
                        defaultValue: `${teamSharedModel.models.length} models available`,
                      })
                    : t('settings.llm.teamSharedNoModelsDetected', 'No models detected')}
                </p>
                <p className="mt-0.5 max-w-[34rem] truncate font-mono text-[10.5px] text-faint" title={teamSharedModel.baseUrl}>
                  {teamSharedModel.baseUrl}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {teamSharedModel.models.length > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  <CircleDot className="h-3 w-3" />
                  {t('settings.llm.teamSharedConfigured', 'Configured')}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {t('settings.llm.teamSharedNoModelsDetected', 'No models detected')}
                </span>
              )}
              {isTeamOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  title={t('settings.llm.teamSharedModelTooltip', 'Configure the team-shared AI model proxy and model list')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTeamSharedLlmOpen(true)
                  }}
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {t('settings.llm.teamSharedReadOnly', '仅团队 owner 可编辑')}
                </span>
              )}
            </div>
          </div>
          {teamSharedModel.models.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border-soft pt-2">
              {teamSharedModel.models.slice(0, 8).map((model) => (
                <span key={model.id} className="rounded-md border border-border bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                  {model.name || model.id}
                </span>
              ))}
              {teamSharedModel.models.length > 8 && (
                <span className="px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  +{teamSharedModel.models.length - 8}
                </span>
              )}
            </div>
          )}
        </SettingCard>
      ) : (
        <SettingCard>
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-[12.5px] text-muted-foreground">
              {t('settings.teamLlmSection.empty', '团队共享模型未配置。')}
            </p>
            {isTeamOwner ? (
              <Button size="sm" className="gap-1.5" onClick={() => setTeamSharedLlmOpen(true)}>
                <Settings className="h-3.5 w-3.5" />
                {t('settings.teamLlmSection.configure', '配置团队共享模型')}
              </Button>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {t('settings.llm.teamSharedReadOnly', '仅团队 owner 可编辑')}
              </p>
            )}
          </div>
        </SettingCard>
      )}
    </div>
  )
}
