import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  Stethoscope,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  formatSkillsDiagnosticsReport,
  runSkillsDiagnostics,
  type SkillDiagnosticCheck,
  type SkillDiagnosticStatus,
  type SkillsDiagnosticsReport,
} from '@/lib/diagnostics/skill-diagnostics'

function statusIcon(status: SkillDiagnosticStatus) {
  switch (status) {
    case 'ok':
      return <Check className="h-4 w-4 shrink-0 text-emerald-500" />
    case 'warn':
      return <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
    case 'fail':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
  }
}

function DiagRow({ check }: { check: SkillDiagnosticCheck }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {statusIcon(check.status)}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-foreground">{check.label}</span>
          {check.detail ? (
            <span className="break-all font-mono text-xs text-muted-foreground">{check.detail}</span>
          ) : null}
        </div>
        {check.hint ? (
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{check.hint}</p>
        ) : null}
      </div>
    </div>
  )
}

function summaryLabel(status: SkillDiagnosticStatus, t: (key: string, fallback: string) => string): string {
  switch (status) {
    case 'ok':
      return t('settings.skills.diag.summaryOk', 'All checks passed')
    case 'warn':
      return t('settings.skills.diag.summaryWarn', 'Issues found — review hints below')
    case 'fail':
      return t('settings.skills.diag.summaryFail', 'Blocking issues found')
  }
}

interface SkillsDiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspacePath: string | null
}

export function SkillsDiagnosticsDialog({
  open,
  onOpenChange,
  workspacePath,
}: SkillsDiagnosticsDialogProps) {
  const { t } = useTranslation()
  const [report, setReport] = React.useState<SkillsDiagnosticsReport | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isRunning, setIsRunning] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const runDiagnostics = React.useCallback(async () => {
    if (!workspacePath) return
    setIsRunning(true)
    setError(null)
    try {
      const next = await runSkillsDiagnostics(workspacePath)
      setReport(next)
    } catch (err) {
      setReport(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRunning(false)
    }
  }, [workspacePath])

  React.useEffect(() => {
    if (!open || !workspacePath) return
    void runDiagnostics()
  }, [open, workspacePath, runDiagnostics])

  const handleCopy = React.useCallback(async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(formatSkillsDiagnosticsReport(report))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }, [report])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85vh,760px)] w-[min(720px,92vw)] flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-blue-500" />
            {t('settings.skills.diag.title', 'Skills diagnostics')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.skills.diag.description',
              'Checks skill directories, daemon inventory, team paths, and runtime refresh state.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {!workspacePath ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <AlertCircle className="h-4 w-4" />
              {t('settings.skills.selectWorkspace', 'Please select a workspace directory first')}
            </div>
          ) : isRunning && !report ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.skills.diag.running', 'Running diagnostics…')}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
              {error}
            </div>
          ) : report ? (
            <>
              <div
                className={cn(
                  'rounded-lg border px-3 py-2 text-[13px]',
                  report.summary === 'ok' && 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20',
                  report.summary === 'warn' && 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20',
                  report.summary === 'fail' && 'border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/20',
                )}
              >
                <p className="font-medium">{summaryLabel(report.summary, t)}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {t('settings.skills.diag.counts', 'Daemon {{daemon}} · FS {{fs}} · Merged {{merged}}', {
                    daemon: report.daemonSkillCount ?? 'n/a',
                    fs: report.fsSkillCount,
                    merged: report.mergedSkillCount,
                  })}
                </p>
              </div>

              <div className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
                {report.checks.map((check) => (
                  <DiagRow key={check.id} check={check} />
                ))}
              </div>

              {report.directories.some((dir) => dir.brokenDirs.length > 0) ? (
                <div className="rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
                  <p className="text-[13px] font-medium text-foreground">
                    {t('settings.skills.diag.brokenTitle', 'Folders missing SKILL.md')}
                  </p>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {report.directories
                      .filter((dir) => dir.brokenDirs.length > 0)
                      .map((dir) => (
                        <li key={dir.path}>
                          <span className="font-mono">{dir.label}</span>: {dir.brokenDirs.join(', ')}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}

              <div className="text-xs text-muted-foreground">
                <p>{t('settings.skills.diag.tipsTitle', 'Common fixes')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>{t('settings.skills.diag.tipRefresh', 'Click Refresh to reload the skills list from disk.')}</li>
                  <li>{t('settings.skills.diag.tipRestart', 'Restart OpenCode after adding or editing skills.')}</li>
                  <li>{t('settings.skills.diag.tipPaths', 'Verify teamclu.json / opencode.json skills.paths point to existing directories.')}</li>
                  <li>{t('settings.skills.diag.tipDaemon', 'Ensure amuxd is running if daemon inventory is missing.')}</li>
                </ul>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleCopy()}
            disabled={!report}
            className="gap-2"
          >
            <Copy className="h-4 w-4" />
            {copied ? t('settings.skills.diag.copied', 'Copied') : t('settings.skills.diag.copy', 'Copy report')}
          </Button>
          <Button onClick={() => void runDiagnostics()} disabled={!workspacePath || isRunning} className="gap-2">
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            {t('settings.skills.diag.rerun', 'Run again')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
