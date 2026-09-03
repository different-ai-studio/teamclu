import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Archive, CheckCircle2, FolderOpen, Loader2, Plus, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  createDaemonWorkspace,
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
  setAgentDefaultWorkspace,
  updateDaemonWorkspace,
  type DaemonAgent,
  type DaemonWorkspace,
} from '@/lib/daemon/daemon-workspaces'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { SectionHeader, SettingCard } from './shared'

function workspaceNameFromPath(path: string | null): string {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

function WorkspaceCard({
  workspace,
  agentDisplayName,
  isDefault,
  showSetDefault,
  settingDefault,
  saving,
  onSetDefault,
  onArchive,
  t,
}: {
  workspace: DaemonWorkspace
  agentDisplayName: string
  isDefault: boolean
  showSetDefault: boolean
  settingDefault: boolean
  saving: boolean
  onSetDefault?: () => void
  onArchive: () => void
  t: (key: string, fallback: string) => string
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-background/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-medium">{workspace.name}</p>
            {isDefault && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                <CheckCircle2 className="h-3 w-3" />
                {t('settings.daemonWorkspaces.default', 'Default')}
              </span>
            )}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-foreground">{workspace.path || '-'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{agentDisplayName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showSetDefault && onSetDefault && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void onSetDefault()} disabled={saving || settingDefault}>
              {settingDefault ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('settings.daemonWorkspaces.setDefault', 'Set default')}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={onArchive} disabled={saving}>
            <Archive className="mr-1 h-3.5 w-3.5" />
            {t('settings.daemonWorkspaces.archive', 'Archive')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function DaemonWorkspacesSection() {
  const { t } = useTranslation()
  const team = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const currentWorkspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [agent, setAgent] = React.useState<DaemonAgent | null>(null)
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [settingDefaultWorkspaceId, setSettingDefaultWorkspaceId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)


  const load = React.useCallback(async () => {
    if (!team?.id) return
    setLoading(true)
    setError(null)
    try {
      const nextAgent = await getCurrentDaemonWorkspaceAgent(team.id)
      setAgent(nextAgent)
      const nextWorkspaces = nextAgent ? await listDaemonWorkspaces(team.id, nextAgent.id) : []
      setWorkspaces(nextWorkspaces)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [team?.id])

  React.useEffect(() => {
    void load()
  }, [load])

  const registerDefaultOnDaemon = async (
    teamId: string,
    agentId: string,
    workspaceId: string,
    workspacePath: string,
  ): Promise<{ daemonRegistered: boolean; daemonError?: string }> => {
    const trimmedPath = workspacePath.trim()
    // The workspace row (and its path) is written once, via createDaemonWorkspace's
    // POST /v1/workspaces — see handleCreate. There is no separate daemon-side
    // registration step; the daemon reads workspace path/UUID from the cloud
    // `workspaces` table (see Task 7/11/12), so re-registering it here via the
    // addWorkspace RPC would be a redundant second write for the same path.
    const daemonRegistered = Boolean(agentId && trimmedPath)
    const daemonError = daemonRegistered
      ? undefined
      : t('settings.daemonWorkspaces.noDaemonDevice', 'No local daemon agent is connected.')

    await setAgentDefaultWorkspace(agentId, workspaceId)

    const refreshed = await getCurrentDaemonWorkspaceAgent(teamId)
    if (refreshed?.defaultWorkspaceId !== workspaceId) {
      throw new Error(t('settings.daemonWorkspaces.defaultPersistFailed', 'Failed to save default workspace to cloud.'))
    }

    setAgent((current) => (current ? { ...current, defaultWorkspaceId: workspaceId } : refreshed))

    return { daemonRegistered, daemonError }
  }

  const notifyDaemonRegistrationWarning = (daemonError: string) => {
    toast.warning(t('settings.daemonWorkspaces.defaultSavedDaemonPending', 'Default workspace saved'), {
      description: t('settings.daemonWorkspaces.daemonRegisterFailed', 'Daemon registration failed: {{message}}', { message: daemonError }),
      duration: 10_000,
    })
  }

  // Pick a directory and register it in one go. There is nothing to fill in
  // that the path does not already answer: the name is derived from it, and a
  // second workspace should not silently steal `default` from the first — so
  // the old form's text input, "Use current" and default checkbox are gone.
  // The very first workspace still becomes default, because otherwise the
  // agent has none.
  const handleAddWorkspace = async () => {
    if (!team?.id || !agent?.id || saving) return
    let picked: string | null = null
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: currentWorkspacePath ?? undefined,
        title: t('settings.daemonWorkspaces.add', 'Add Workspace'),
      })
      picked = typeof selected === 'string' ? selected.trim() : null
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    if (!picked) return

    if (workspaces.some((w) => w.path === picked)) {
      toast.info(t('settings.daemonWorkspaces.alreadyRegistered', 'That directory is already registered.'))
      return
    }

    const name = workspaceNameFromPath(picked)
    if (!name) return

    setSaving(true)
    setError(null)
    try {
      const created = await createDaemonWorkspace({
        teamId: team.id,
        agentId: agent.id,
        createdByMemberId: currentMember?.id ?? null,
        name,
        path: picked,
      })
      const isFirst = workspaces.length === 0
      if (isFirst) {
        const registration = await registerDefaultOnDaemon(team.id, agent.id, created.id, picked)
        await load()
        if (!registration.daemonRegistered && registration.daemonError) {
          notifyDaemonRegistrationWarning(registration.daemonError)
        }
      } else {
        await load()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSetDefault = async (agentId: string, workspaceId: string, workspacePath: string) => {
    if (!team?.id) return
    setSaving(true)
    setSettingDefaultWorkspaceId(workspaceId)
    setError(null)
    try {
      const registration = await registerDefaultOnDaemon(team.id, agentId, workspaceId, workspacePath)
      await load()
      if (!registration.daemonRegistered && registration.daemonError) {
        notifyDaemonRegistrationWarning(registration.daemonError)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
      setSettingDefaultWorkspaceId(null)
    }
  }

  const handleArchive = async (workspace: DaemonWorkspace, archived: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await updateDaemonWorkspace({
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path ?? '',
        archived,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const activeWorkspaces = workspaces.filter((workspace) => !workspace.archived)
  const archivedWorkspaces = workspaces.filter((workspace) => workspace.archived)
  const defaultWorkspace = agent?.defaultWorkspaceId
    ? activeWorkspaces.find((workspace) => workspace.id === agent.defaultWorkspaceId) ?? null
    : null
  const otherWorkspaces = activeWorkspaces.filter((workspace) => workspace.id !== agent?.defaultWorkspaceId)
  const agentDisplayName = agent?.displayName || t('settings.daemonWorkspaces.unknownAgent', 'Unknown agent')
  const resolveAgentId = (workspace: DaemonWorkspace) => workspace.agentId ?? agent?.id ?? null

  if (!team) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={FolderOpen}
          title={t('settings.daemonWorkspaces.title', 'Workspace')}
          description={t('settings.daemonWorkspaces.description', 'Manage workspaces that daemon agents can use')}
          iconColor="text-slate-500"
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonWorkspaces.noTeam', 'Join or create a team before configuring daemon workspaces.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          icon={FolderOpen}
          title={t('settings.daemonWorkspaces.title', 'Workspace')}
          description={t('settings.daemonWorkspaces.description', 'Manage workspaces that daemon agents can use')}
          iconColor="text-slate-500"
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

      {!agent && !loading && (
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonWorkspaces.noCurrentAgent', 'No daemon agent is associated with this machine yet.')}
          </p>
        </SettingCard>
      )}

      <SettingCard>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{t('settings.daemonWorkspaces.availableTitle', 'Daemon workspaces')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.daemonWorkspaces.availableDesc', 'Rows are read from public.workspaces. Default workspace updates public.agents.default_workspace_id.')}
              </p>
              {agent && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('settings.daemonWorkspaces.bindToAgent', 'Will bind to local agent {{name}}', { name: agent.displayName })}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5"
              onClick={handleAddWorkspace}
              disabled={saving || !agent?.id}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t('settings.daemonWorkspaces.add', 'Add Workspace')}
            </Button>
          </div>

          {loading && workspaces.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : activeWorkspaces.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('settings.daemonWorkspaces.empty', 'No daemon workspaces configured yet.')}</p>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{t('settings.daemonWorkspaces.defaultTitle', 'Default workspace')}</p>
                {defaultWorkspace ? (
                  <WorkspaceCard
                    workspace={defaultWorkspace}
                    agentDisplayName={agentDisplayName}
                    isDefault
                    showSetDefault={false}
                    settingDefault={false}
                    saving={saving}
                    onArchive={() => handleArchive(defaultWorkspace, true)}
                    t={t}
                  />
                ) : (
                  <p className="text-[13px] text-muted-foreground">{t('settings.daemonWorkspaces.noDefault', 'No default workspace set yet.')}</p>
                )}
              </div>

              {otherWorkspaces.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{t('settings.daemonWorkspaces.othersTitle', 'Other workspaces')}</p>
                  <div className="space-y-2">
                    {otherWorkspaces.map((workspace) => {
                      const workspaceAgentId = resolveAgentId(workspace)
                      return (
                      <WorkspaceCard
                        key={workspace.id}
                        workspace={workspace}
                        agentDisplayName={agentDisplayName}
                        isDefault={false}
                        showSetDefault={Boolean(workspaceAgentId)}
                        settingDefault={settingDefaultWorkspaceId === workspace.id}
                        saving={saving}
                        onSetDefault={
                          workspaceAgentId
                            ? () => handleSetDefault(workspaceAgentId, workspace.id, workspace.path ?? '')
                            : undefined
                        }
                        onArchive={() => handleArchive(workspace, true)}
                        t={t}
                      />
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingCard>

      {archivedWorkspaces.length > 0 && (
        <SettingCard>
          <div className="space-y-3">
            <p className="text-[13px] font-medium">{t('settings.daemonWorkspaces.archivedTitle', 'Archived')}</p>
            {archivedWorkspaces.map((workspace) => (
              <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-muted-foreground">{workspace.name}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{workspace.path || '-'}</p>
                </div>
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => handleArchive(workspace, false)} disabled={saving}>
                  {t('settings.daemonWorkspaces.restore', 'Restore')}
                </Button>
              </div>
            ))}
          </div>
        </SettingCard>
      )}

    </div>
  )
}
