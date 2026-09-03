import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Plus,
  Trash2,
  Edit2,
  Play,
  AlertCircle,
  Loader2,
  History,
  X,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useCronStore,
  formatSchedule,
  formatRelativeTime,
  getChannelDisplayName,
  type CronJob,
  type CronScope,
} from '@/stores/cron'
import { ToggleSwitch } from './shared'
import { getDeliveryTargetDisplay } from '@/lib/cron-utils'
import { CronJobDialog } from './cron/CronJobDialog'
import { CronHistoryDialog } from './cron/CronHistoryDialog'
import {
  listLocalDaemonWorkspaces,
  type LocalDaemonWorkspace,
} from '@/lib/cron-workspace-models'
import { useShallow } from 'zustand/react/shallow'

// ==================== Job Card ====================

function JobCard({
  job,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  onViewHistory,
  isRunning,
}: {
  job: CronJob
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onViewHistory: () => void
  isRunning: boolean
}) {
  const { t } = useTranslation()
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-all',
        job.enabled ? 'bg-card' : 'bg-muted/30 opacity-75'
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <ToggleSwitch enabled={job.enabled} onChange={onToggle} />
          <h4 className="font-medium">{job.name}</h4>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted">
            {formatSchedule(job.schedule)}
          </span>
          {job.enabled ? (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              {t('settings.cron.active', 'Active')}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('settings.cron.paused', 'Paused')}</span>
          )}
        </div>
      </div>

      {/* Description */}
      {job.description && (
        <p className="text-[13px] text-muted-foreground mb-2">{job.description}</p>
      )}

      {/* Info row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
        {job.lastRunAt && (
          <span>{t('settings.cron.lastRun', 'Last run')}: {formatRelativeTime(job.lastRunAt)}</span>
        )}
        {job.nextRunAt && job.enabled && (
          <span>{t('settings.cron.nextRun', 'Next')}: {formatRelativeTime(job.nextRunAt)}</span>
        )}
        {job.delivery && (
          <span className="flex items-center gap-1">
            <Send className="h-3 w-3" />
            {getChannelDisplayName(job.delivery.channel)} &rarr; {getDeliveryTargetDisplay(job.delivery)}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRun}
          disabled={!job.enabled || isRunning}
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
        >
          {isRunning ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Play className="h-3 w-3 mr-1" />
          )}
          {t('settings.cron.runNow', 'Run Now')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
        >
          <Edit2 className="h-3 w-3 mr-1" />
          {t('settings.cron.edit', 'Edit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onViewHistory}
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
        >
          <History className="h-3 w-3 mr-1" />
          {t('settings.cron.history', 'History')}
        </Button>
        {confirmDelete ? (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-destructive">{t('settings.cron.confirm', 'Confirm?')}</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDelete()
                setConfirmDelete(false)
              }}
              className="h-7 text-xs"
            >
              {t('fileExplorer.delete', 'Delete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              className="h-7 text-xs"
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="h-7 text-xs ml-auto text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ==================== Main CronSection ====================

export function CronSection() {
  const { t } = useTranslation()
  const {
    jobs,
    isLoading,
    error,
    activeScope,
    selectedWorkspacePath,
    setScope,
    setSelectedWorkspacePath,
    loadJobs,
    removeJob,
    toggleEnabled,
    runJob,
    clearError,
    runningJobIds,
  } = useCronStore(
    useShallow((s) => ({ jobs: s.jobs, isLoading: s.isLoading, error: s.error, activeScope: s.activeScope, selectedWorkspacePath: s.selectedWorkspacePath, setScope: s.setScope, setSelectedWorkspacePath: s.setSelectedWorkspacePath, loadJobs: s.loadJobs, removeJob: s.removeJob, toggleEnabled: s.toggleEnabled, runJob: s.runJob, clearError: s.clearError, runningJobIds: s.runningJobIds })),
  )

  const [formOpen, setFormOpen] = React.useState(false)
  const [editJob, setEditJob] = React.useState<CronJob | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [historyJob, setHistoryJob] = React.useState<CronJob | null>(null)
  const [workspaceOptions, setWorkspaceOptions] = React.useState<LocalDaemonWorkspace[]>([])
  const [workspaceOptionsLoading, setWorkspaceOptionsLoading] = React.useState(false)

  React.useEffect(() => {
    loadJobs()
    const interval = setInterval(() => {
      loadJobs()
    }, 30000)
    return () => clearInterval(interval)
  }, [loadJobs, activeScope])

  React.useEffect(() => {
    let cancelled = false
    setWorkspaceOptionsLoading(true)
    ;(async () => {
      const rows = await listLocalDaemonWorkspaces()
      if (cancelled) return
      setWorkspaceOptions(rows.filter((row) => !!row.path))
    })()
      .catch(() => {
        if (!cancelled) setWorkspaceOptions([])
      })
      .finally(() => {
        if (!cancelled) setWorkspaceOptionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (activeScope !== 'workspace') return
    if (selectedWorkspacePath) return
    const firstPath = workspaceOptions[0]?.path ?? null
    if (!firstPath) return
    void setSelectedWorkspacePath(firstPath)
  }, [activeScope, selectedWorkspacePath, setSelectedWorkspacePath, workspaceOptions])

  const handleScopeChange = (scope: CronScope) => {
    if (scope === activeScope) return
    if (scope === 'workspace' && !selectedWorkspacePath && workspaceOptions.length === 0) return
    void setScope(scope)
  }

  const handleOpenCreate = () => {
    setEditJob(undefined)
    setFormOpen(true)
  }

  const handleOpenEdit = (job: CronJob) => {
    setEditJob(job)
    setFormOpen(true)
  }

  const handleViewHistory = (job: CronJob) => {
    setHistoryJob(job)
    setHistoryOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="rounded-[14px] border border-border-soft bg-panel p-3">
          <Clock className="h-5 w-5 text-amber-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-[15px] font-semibold tracking-normal">{t('settings.cron.automation', 'Automation')}</h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {t('settings.cron.automationDesc', 'Schedule recurring tasks for your AI agent. Jobs run automatically and can deliver results through configured channels.')}
          </p>
        </div>
        <Button onClick={handleOpenCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          {t('settings.cron.newJob', 'New Job')}
        </Button>
      </div>

      <div className="rounded-[14px] border border-border-soft bg-paper p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleScopeChange('global')}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              activeScope === 'global'
                ? 'bg-panel text-foreground'
                : 'text-muted-foreground hover:bg-panel/60',
            )}
          >
            {t('settings.cron.scopeGlobal', 'Global tasks')}
          </button>
          <button
            type="button"
            onClick={() => handleScopeChange('workspace')}
            disabled={workspaceOptionsLoading || workspaceOptions.length === 0}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              activeScope === 'workspace'
                ? 'bg-panel text-foreground'
                : 'text-muted-foreground hover:bg-panel/60',
              (workspaceOptionsLoading || workspaceOptions.length === 0) &&
                'cursor-not-allowed opacity-40',
            )}
          >
            {t('settings.cron.scopeWorkspace', 'Workspace tasks')}
          </button>
        </div>
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          {activeScope === 'global'
            ? t(
                'settings.cron.scopeGlobalHint',
                'Runs use the daemon default workspace. Changing the default updates future runs.',
              )
            : t(
                'settings.cron.scopeWorkspaceHint',
                'Runs in the selected daemon workspace — suitable for project files, git worktrees, and MCP/skills.',
              )}
        </p>
        {activeScope === 'workspace' && (
          <div className="mt-3 flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wide text-faint">
              {t('settings.cron.workspaceSelectLabel', 'Workspace')}
            </label>
            <Select
              value={selectedWorkspacePath ?? undefined}
              disabled={workspaceOptionsLoading || workspaceOptions.length === 0}
              onValueChange={(value) => void setSelectedWorkspacePath(value || null)}
            >
              <SelectTrigger className="h-8 w-full rounded-lg border-border-soft bg-background text-[12.5px] shadow-none">
                <SelectValue
                  placeholder={t('settings.cron.workspaceSelectPlaceholder', 'Select workspace')}
                />
              </SelectTrigger>
              <SelectContent>
                {workspaceOptions.map((workspace) => (
                  <SelectItem key={workspace.workspaceId} value={workspace.path}>
                    {workspace.displayName || workspace.path} · {workspace.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-[13px]">
          <AlertCircle className="h-4 w-4" />
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="sm" onClick={clearError} className="h-6 w-6 p-0">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && jobs.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && jobs.length === 0 && (
        <div className="rounded-xl border border-dashed py-12 text-center">
          <Clock className="mx-auto mb-4 h-10 w-10 text-muted-foreground/50" />
          <h4 className="mb-2 text-[15px] font-semibold">{t('settings.cron.noJobs', 'No scheduled jobs yet')}</h4>
          <p className="mx-auto mb-4 max-w-md text-[12.5px] text-muted-foreground">
            {t('settings.cron.noJobsDesc', 'Create your first automated task to have your AI agent perform actions on a schedule. For example, check your approval platform every 30 minutes.')}
          </p>
          <Button onClick={handleOpenCreate}>
            <Plus className="h-4 w-4 mr-1" />
            {t('settings.cron.createFirstJob', 'Create Your First Job')}
          </Button>
        </div>
      )}

      {/* Job List */}
      {jobs.length > 0 && (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onEdit={() => handleOpenEdit(job)}
              onDelete={() => removeJob(job.id)}
              onToggle={(enabled) => toggleEnabled(job.id, enabled)}
              onRun={() => void runJob(job.id)}
              onViewHistory={() => handleViewHistory(job)}
              isRunning={runningJobIds.has(job.id)}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <CronJobDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) {
            setEditJob(undefined)
            // Refresh jobs after form closes
            loadJobs()
          }
        }}
        editJob={editJob}
      />

      <CronHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        job={historyJob}
      />
    </div>
  )
}
