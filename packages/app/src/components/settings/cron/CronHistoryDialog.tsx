/**
 * CronHistoryDialog - Run history dialog and record card.
 * Extracted from CronSection.tsx.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  History,
  Send,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'
import {
  hydrateCronSessionMessages,
  ensureCronSessionVisible,
} from '@/lib/cron-session-messages'
import { useSessionMessageStore } from '@/stores/session-message-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  useCronStore,
  formatRelativeTime,
  getRunStatusColor,
  type CronJob,
  type CronRunRecord,
} from '@/stores/cron'
import { useShallow } from 'zustand/react/shallow'

export { ensureCronSessionVisible } from '@/lib/cron-session-messages'

export function RunRecordCard({
  run,
  onViewSession,
}: {
  run: CronRunRecord
  onViewSession?: (sessionId: string, run: CronRunRecord) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [isHovered, setIsHovered] = React.useState(false)
  const statusColor = getRunStatusColor(run.status)
  const duration =
    run.startedAt && run.finishedAt
      ? (
          (new Date(run.finishedAt).getTime() -
            new Date(run.startedAt).getTime()) /
          1000
        ).toFixed(1) + 's'
      : '...'
  const showHeartbeat = !!run.lastHeartbeatAt && (run.status === 'running' || run.status === 'stale')
  const [viewing, setViewing] = React.useState(false)

  const handleViewSession = async () => {
    if (!run.sessionId || !onViewSession || viewing) return
    setViewing(true)
    try {
      await onViewSession(run.sessionId, run)
    } finally {
      setViewing(false)
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {run.status === 'success' && (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          )}
          {run.status === 'failed' && (
            <AlertCircle className="h-4 w-4 text-red-500" />
          )}
          {run.status === 'timeout' && (
            <Clock className="h-4 w-4 text-orange-500" />
          )}
          {run.status === 'running' && (
            <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
          )}
          {run.status === 'stale' && (
            <AlertCircle className="h-4 w-4 text-yellow-500" />
          )}
          <span className={cn('text-[13px] font-medium capitalize', statusColor)}>
            {run.status}
          </span>
        </div>
        <div
          className="text-xs text-muted-foreground relative"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <span className={cn(
            "absolute inset-0 flex items-center justify-end transition-opacity duration-300",
            isHovered ? "opacity-0" : "opacity-100"
          )}>
            {formatRelativeTime(run.startedAt)}
          </span>
          <span className={cn(
            "transition-opacity duration-300 whitespace-nowrap",
            isHovered ? "opacity-100" : "opacity-0"
          )}>
            {t('settings.cron.started', 'Started')}: {formatRelativeTime(run.startedAt)} {t('settings.cron.duration', 'Duration')}: {duration}
          </span>
        </div>
      </div>

      {run.responseSummary && (
        <p className="text-xs text-muted-foreground line-clamp-3 bg-muted/30 rounded p-2">
          {run.responseSummary}
        </p>
      )}

      {run.deliveryStatus && (
        <p className="text-xs text-muted-foreground">
          <Send className="h-3 w-3 inline mr-1" />
          {run.deliveryStatus}
        </p>
      )}

      {showHeartbeat && (
        <p className="text-xs text-muted-foreground">
          <Clock className="h-3 w-3 inline mr-1" />
          {t('settings.cron.lastHeartbeat', 'Last heartbeat')}: {formatRelativeTime(run.lastHeartbeatAt!)}
        </p>
      )}

      {run.error && (
        <p className="text-xs text-destructive">
          <AlertCircle className="h-3 w-3 inline mr-1" />
          {run.error}
        </p>
      )}

      {run.sessionId && onViewSession && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={viewing}
          onClick={handleViewSession}
        >
          {viewing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <MessageSquare className="h-3 w-3 mr-1" />}
          {t('settings.cron.viewConversation')}
        </Button>
      )}
    </div>
  )
}

export function CronHistoryDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  job: CronJob | null
}) {
  const { t } = useTranslation()
  const { runs, runsLoading, loadRuns } = useCronStore(
    useShallow((s) => ({ runs: s.runs, runsLoading: s.runsLoading, loadRuns: s.loadRuns })),
  )
  const [viewError, setViewError] = React.useState<string | null>(null)

  const handleViewSession = React.useCallback(async (sessionId: string, run: CronRunRecord) => {
    setViewError(null)
    try {
      await ensureCronSessionVisible(sessionId)
      useCronStore.getState().setShowCronSessions(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setViewError(message)
      toast.error(message)
      return
    }
    // Close the dialog first, then navigate so the chat view is visible
    onOpenChange(false)
    await useUIStore.getState().switchToSession(sessionId)
    await hydrateCronSessionMessages(sessionId, {
      fallbackSummary: run.responseSummary,
      runId: run.runId,
    })
    await useSessionMessageStore.getState().reloadActiveSessionMessages({ full: true })
  }, [onOpenChange])

  React.useEffect(() => {
    if (open && job) {
      setViewError(null)
      loadRuns(job.id)
    }
  }, [open, job?.id])

  // Auto-refresh while any run is still in progress
  const hasRunningRun = runs.some((r) => r.status === 'running')
  React.useEffect(() => {
    if (!open || !job || !hasRunningRun) return
    const id = setInterval(() => {
      loadRuns(job.id)
    }, 5000)
    return () => clearInterval(id)
  }, [open, job?.id, hasRunningRun])

  if (!job) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('settings.cron.runHistory', 'Run History')}: {job.name}
          </DialogTitle>
          <DialogDescription>
            {t('settings.cron.runHistoryDesc', 'Recent execution history for this job.')}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh]">
          {runsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-[13px]">{t('settings.cron.noRunHistory', 'No run history yet')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map((run) => (
                <RunRecordCard key={run.runId} run={run} onViewSession={handleViewSession} />
              ))}
            </div>
          )}
          {viewError && (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {viewError}
            </p>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
