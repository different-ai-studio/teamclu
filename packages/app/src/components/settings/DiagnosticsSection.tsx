import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  LifeBuoy,
  Loader2,
  Play,
  Copy,
  Download,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from 'lucide-react'
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
import { SettingCard, SectionHeader } from './shared'
import { cn, isTauri, openExternalUrl } from '@/lib/utils'
import { useUIStore, type SettingsSection } from '@/stores/ui'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import { useAuthStore } from '@/stores/auth-store'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { recoverMqttConnection } from '@/stores/mqtt-reconnect'
import type { RemediationId } from '@/lib/diagnostics/remediations'
import {
  collectDiagnosticReport,
  copyDiagnosticReport,
  saveDiagnosticZip,
  GITHUB_ISSUES_URL,
  type DiagnosticCheck,
  type DiagnosticStatus,
} from '@/lib/diagnostic-report'
import { LiveDebugConsole } from './LiveDebugConsole'
import { DaemonResetRemediationCard } from './DaemonResetRemediationCard'
import { AuthSyncBanner, DiagnosticSymptomPanel } from './DiagnosticSymptomPanel'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { firstFailingTab, worstFindingStatus, type SymptomTab } from '@/lib/diagnostics/view'

function statusDot(status: DiagnosticStatus) {
  switch (status) {
    case 'ok':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
    case 'warn':
      return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
    case 'fail':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" />
  }
}

function CheckRow({
  check,
  onOpenHint,
}: {
  check: DiagnosticCheck
  onOpenHint: (section: SettingsSection) => void
}) {
  return (
    <div className="flex items-start gap-2 py-2 border-b border-border-soft last:border-0">
      {statusDot(check.status)}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-foreground">{check.title}</span>
          <span className="text-[12px] text-muted-foreground">{check.message}</span>
        </div>
        {check.hint && (
          <p className="text-[12px] text-muted-foreground mt-0.5">{check.hint}</p>
        )}
        {check.hintSection && (
          <button
            type="button"
            onClick={() => onOpenHint(check.hintSection!)}
            className="text-[12px] text-coral hover:underline mt-0.5"
          >
            前往相关设置 →
          </button>
        )}
      </div>
    </div>
  )
}

const SYMPTOM_TABS: Array<{ id: SymptomTab | 'all'; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'send', label: '消息回复' },
  { id: 'realtime', label: '实时通道' },
  { id: 'all', label: '全部检查' },
]

function tabTone(status: 'ok' | 'warn' | 'fail' | null): string {
  if (status === 'fail') return 'text-destructive'
  if (status === 'warn') return 'text-amber-600'
  return ''
}

export const DiagnosticsSection = React.memo(function DiagnosticsSection() {
  const { t } = useTranslation()
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const report = useDiagnosticsStore((s) => s.report)
  const setReport = useDiagnosticsStore((s) => s.setReport)
  const focusSessionId = useDiagnosticsStore((s) => s.focusSessionId ?? null)
  const preferredTab = useDiagnosticsStore((s) => s.preferredTab ?? null)
  const signOut = useAuthStore((s) => s.signOut)
  const forceReset = useDaemonOnboardingStore((s) => s.forceReset)

  const [running, setRunning] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState<SymptomTab | 'all'>('model')
  const [confirmAction, setConfirmAction] = React.useState<Extract<RemediationId, 'relogin' | 'reset_daemon'> | null>(null)
  const [showWizard, setShowWizard] = React.useState(false)
  const autoRanForSession = React.useRef<string | null>(null)

  const runDiagnostics = React.useCallback(async () => {
    if (!isTauri()) {
      toast.error(t('settings.diagnostics.desktopOnly', '一键诊断仅支持 Desktop 客户端'))
      return
    }
    setRunning(true)
    try {
      const next = await collectDiagnosticReport()
      setReport(next)
      toast.success(t('settings.diagnostics.runComplete', '诊断完成'))
    } catch (err) {
      toast.error(
        t('settings.diagnostics.runFailed', '诊断失败：{{message}}', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setRunning(false)
    }
  }, [t, setReport])

  React.useEffect(() => {
    if (!report) return
    if (preferredTab) {
      setActiveTab(preferredTab)
      return
    }
    setActiveTab(firstFailingTab(report.findings ?? []))
  }, [report, preferredTab])

  React.useEffect(() => {
    if (!isTauri() || !focusSessionId) return
    if (autoRanForSession.current === focusSessionId) return
    autoRanForSession.current = focusSessionId
    void runDiagnostics()
  }, [focusSessionId, runDiagnostics])

  const handleCopy = React.useCallback(async () => {
    if (!report) return
    try {
      await copyDiagnosticReport(report)
    } catch {
      toast.error(t('settings.diagnostics.copyFailed', '复制失败'))
    }
  }, [report, t])

  const handleExportZip = React.useCallback(async () => {
    if (!report) return
    setExporting(true)
    try {
      const dest = await saveDiagnosticZip(report)
      if (dest) {
        toast.success(t('settings.diagnostics.exported', '诊断包已保存'))
      }
    } catch (err) {
      toast.error(
        t('settings.diagnostics.exportFailed', '导出失败：{{message}}', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setExporting(false)
    }
  }, [report, t])

  const handleReportIssue = React.useCallback(async () => {
    if (report) {
      try {
        await copyDiagnosticReport(report)
        toast.info(t('settings.diagnostics.pasteHint', '诊断报告已复制，请在 Issue 中粘贴'))
      } catch {
        /* best-effort */
      }
    }
    openExternalUrl(GITHUB_ISSUES_URL)
  }, [report, t])

  const handleOpenHint = React.useCallback(
    (section: SettingsSection) => {
      openSettings(section)
    },
    [openSettings],
  )

  const handleRemediate = React.useCallback(
    (id: RemediationId) => {
      if (id === 'relogin' || id === 'reset_daemon') {
        setConfirmAction(id)
        return
      }
      if (id === 'open_llm' || id === 'reselect_model') {
        openSettings('llm')
        return
      }
      if (id === 'reconnect_mqtt') {
        void recoverMqttConnection()
          .then(() => toast.success(t('settings.diagnostics.mqttReconnected', '已请求重连 MQTT')))
          .catch((err) =>
            toast.error(
              t('settings.diagnostics.mqttReconnectFailed', '重连失败：{{message}}', {
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        return
      }
      if (id === 'retry_diagnose') {
        void runDiagnostics()
        return
      }
      if (id === 'export_report') {
        void handleExportZip()
      }
    },
    [handleExportZip, openSettings, runDiagnostics, t],
  )

  const handleConfirmRemediate = React.useCallback(async () => {
    const action = confirmAction
    setConfirmAction(null)
    if (action === 'relogin') {
      try {
        await signOut()
        closeSettings()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (action === 'reset_daemon') {
      try {
        await forceReset()
        if (useDaemonOnboardingStore.getState().error) {
          toast.error(useDaemonOnboardingStore.getState().error)
          return
        }
        setShowWizard(true)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  }, [closeSettings, confirmAction, forceReset, signOut])

  if (!isTauri()) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={LifeBuoy}
          title={t('settings.diagnostics.title', '诊断与支持')}
          description={t(
            'settings.diagnostics.description',
            '收集连接状态与日志，帮助快速定位问题',
          )}
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t(
              'settings.diagnostics.desktopOnlyDetail',
              '一键诊断需要在 Desktop 客户端中使用。请下载并安装 TeamClu Desktop 后重试。',
            )}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={LifeBuoy}
        title={t('settings.diagnostics.title', '诊断与支持')}
        description={t(
          'settings.diagnostics.description',
          '收集连接状态与日志，帮助快速定位问题',
        )}
      />

      <LiveDebugConsole />

      <SettingCard>
        <p className="text-[13px] text-muted-foreground mb-4">
          {t(
            'settings.diagnostics.privacyNote',
            '运行后会收集版本、连接状态与最近日志（已脱敏），数据不会自动上传。',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runDiagnostics} disabled={running} className="gap-2">
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('settings.diagnostics.running', '正在诊断…')}
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                {t('settings.diagnostics.run', '运行诊断')}
              </>
            )}
          </Button>
          {report && (
            <span className="text-[12px] font-mono text-faint">
              {t('settings.diagnostics.summary', '{{ok}} 通过 · {{warn}} 警告 · {{fail}} 失败', {
                ok: report.summary.ok,
                warn: report.summary.warn,
                fail: report.summary.fail,
              })}
              {' · '}
              {new Date(report.generatedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      </SettingCard>

      {report && (
        <>
          <AuthSyncBanner findings={report.findings ?? []} onRemediate={handleRemediate} />
          {focusSessionId && (
            <p className="text-[12px] font-mono text-faint">
              {t('settings.diagnostics.sessionFocus', '正在查看会话 {{id}}', {
                id: focusSessionId,
              })}
            </p>
          )}
          <SettingCard>
            <div role="tablist" className="mb-4 flex flex-wrap gap-1 rounded-[10px] bg-panel p-1">
              {SYMPTOM_TABS.map((tab) => {
                const status =
                  tab.id === 'all'
                    ? null
                    : worstFindingStatus(
                        (report.findings ?? []).filter((item) => item.symptom === tab.id),
                      )
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'h-8 rounded-[8px] px-3 text-[13px] font-medium transition-colors',
                      activeTab === tab.id
                        ? 'bg-paper text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                      tabTone(status),
                    )}
                  >
                    {t(`settings.diagnostics.tab.${tab.id}`, tab.label)}
                  </button>
                )
              })}
            </div>
            {activeTab === 'all' ? (
              <div>
                <h4 className="mb-2 text-[13px] font-semibold">
                  {t('settings.diagnostics.results', '检查结果')}
                </h4>
                {report.checks.map((check) => (
                  <CheckRow key={check.id} check={check} onOpenHint={handleOpenHint} />
                ))}
              </div>
            ) : (
              <DiagnosticSymptomPanel
                tab={activeTab}
                findings={report.findings ?? []}
                traces={report.traces ?? []}
                sessionId={focusSessionId}
                onOpenHint={handleOpenHint}
                onRemediate={handleRemediate}
              />
            )}
          </SettingCard>

          <DaemonResetRemediationCard report={report} />

          <SettingCard>
            <h4 className="text-[13px] font-semibold mb-3">
              {t('settings.diagnostics.exportTitle', '导出与反馈')}
            </h4>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy} className="gap-2">
                <Copy className="h-4 w-4" />
                {t('settings.diagnostics.copyReport', '复制诊断报告')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportZip}
                disabled={exporting}
                className="gap-2"
              >
                {exporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('settings.diagnostics.exportZip', '导出 zip 包')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleReportIssue} className="gap-2">
                <ExternalLink className="h-4 w-4" />
                {t('settings.diagnostics.reportIssue', '在 GitHub 报告问题')}
              </Button>
            </div>
          </SettingCard>
        </>
      )}

      <AlertDialog open={Boolean(confirmAction)} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'relogin'
                ? t('settings.diagnostics.confirmReloginTitle', '重新登录？')
                : t('settings.diagnostics.resetRemediation.confirmTitle', '重置本地 daemon？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'relogin'
                ? t(
                    'settings.diagnostics.confirmReloginDescription',
                    '将退出当前账号并返回登录页，以便刷新会话与 MQTT 凭据。',
                  )
                : t(
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
                void handleConfirmRemediate()
              }}
            >
              {confirmAction === 'relogin'
                ? t('settings.diagnostics.confirmReloginAction', '确认退出')
                : t('settings.diagnostics.resetRemediation.confirmAction', '确认重置')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showWizard && (
        <div className="fixed inset-0 z-50">
          <DaemonOnboardingWizard onDone={() => setShowWizard(false)} />
        </div>
      )}
    </div>
  )
})
