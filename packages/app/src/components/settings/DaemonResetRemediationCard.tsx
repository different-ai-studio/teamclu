import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SettingCard } from './shared'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import {
  collectDaemonResetRemediation,
  type DiagnosticCheck,
  type DiagnosticReport,
} from '@/lib/diagnostics/diagnostic-report'

export function DaemonResetRemediationCard({
  report,
}: {
  report: DiagnosticReport
}) {
  const { t } = useTranslation()
  const forceReset = useDaemonOnboardingStore((s) => s.forceReset)
  const onboardingBusy = useDaemonOnboardingStore((s) => s.busy)
  const onboardingStatus = useDaemonOnboardingStore((s) => s.status)
  const healError = useDaemonOnboardingStore((s) => s.healError)

  const remediation = React.useMemo(
    () =>
      collectDaemonResetRemediation(report.checks, {
        cloudAuthHealFailed: Boolean(healError),
        teamMismatch: onboardingStatus === 'mismatch',
      }),
    [healError, onboardingStatus, report.checks],
  )

  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [showWizard, setShowWizard] = React.useState(false)
  const [resetError, setResetError] = React.useState<string | null>(null)

  const handleReset = React.useCallback(async () => {
    setResetError(null)
    try {
      await forceReset()
      if (useDaemonOnboardingStore.getState().error) {
        setResetError(useDaemonOnboardingStore.getState().error)
        return
      }
      setShowWizard(true)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    }
  }, [forceReset])

  if (!remediation.suggest) return null

  return (
    <>
      <SettingCard className="border-amber-500/25 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h4 className="text-[13px] font-semibold text-foreground">
                {t('settings.diagnostics.resetRemediation.title', '建议重置本地 daemon')}
              </h4>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {t(
                  'settings.diagnostics.resetRemediation.description',
                  '以下问题通常可通过清除本机 daemon 绑定并重新初始化解决。团队共享目录（~/.amuxd/teams/）不会受影响。',
                )}
              </p>
            </div>
            <ul className="space-y-1">
              {remediation.triggers.map((check: DiagnosticCheck) => (
                <li key={`${check.id}-${check.resetTrigger ?? check.message}`} className="text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground">{check.title}</span>
                  {' — '}
                  {check.message}
                </li>
              ))}
            </ul>
            {resetError && (
              <p className="text-[12px] text-destructive">{resetError}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 border-destructive/30 text-destructive hover:bg-destructive/5"
              disabled={onboardingBusy}
              onClick={() => setConfirmOpen(true)}
            >
              {onboardingBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {t('settings.diagnostics.resetRemediation.action', '重置本地 daemon')}
            </Button>
          </div>
        </div>
      </SettingCard>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.diagnostics.resetRemediation.confirmTitle', '重置本地 daemon？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.diagnostics.resetRemediation.confirmDescription',
                '将清除本机 daemon 的身份与配置文件，之后需要重新绑定 agent。团队共享文件不会删除。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', '取消')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                setConfirmOpen(false)
                void handleReset()
              }}
            >
              {t('settings.diagnostics.resetRemediation.confirmAction', '确认重置')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showWizard && (
        <div className="fixed inset-0 z-50">
          <DaemonOnboardingWizard
            onDone={() => {
              setShowWizard(false)
            }}
          />
        </div>
      )}
    </>
  )
}
