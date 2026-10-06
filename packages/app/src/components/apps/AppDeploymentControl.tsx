import * as React from 'react'
import { CheckCircle2, Loader2, CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { getBackend } from '@/lib/backend/provider'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

/** Only server-resolved management permission exposes the destructive action. */
export function AppDeploymentControl({ app, compact = false, disabled = false }: { app: AppRow; compact?: boolean; disabled?: boolean }) {
  const { t } = useTranslation()
  const undeploy = useAppsStore(s => s.undeployApp)
  const deploy = useAppsStore(s => s.deploy)
  const deploying = useAppsStore(s => s.deployingIds?.includes(app.id) ?? false)
  const syncApp = useAppsStore(s => s.syncApp)
  const refresh = useAppsStore(s => s.refreshApp)
  const [current, setCurrent] = React.useState(app)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [readError, setReadError] = React.useState(false)
  React.useEffect(() => { setCurrent(app) }, [app])
  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const row = await getBackend().apps.getApp(app.id)
        if (stopped) return
        if (row) { setCurrent(row); syncApp(row); setReadError(false) }
        if (row?.fcStatus === 'uninstalling') timer = setTimeout(read, 2000)
      } catch { if (!stopped) setReadError(true) }
    }
    void read()
    return () => { stopped = true; clearTimeout(timer) }
  }, [app.id, app.fcStatus, busy, syncApp])
  const pending = disabled || deploying || busy || current.fcStatus === 'uninstalling'
  const conflict = ['awaiting_build', 'building', 'deploying'].includes(current.fcStatus ?? '')
  const deployed = !!current.fcStatus && !['not_deployed', 'uninstalled'].includes(current.fcStatus)
  const approve = async () => {
    setBusy(true)
    try { if (await undeploy(app.id)) { setOpen(false); await refresh(app.id) } }
    finally { setBusy(false) }
  }
  if (compact && current.canManageDeployment !== true) return null
  return <div className={compact ? "inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground" : "space-y-3 text-[12.5px] text-muted-foreground"} data-testid="app-undeploy-control">
    {compact && <span className="mr-2 text-faint" aria-hidden>·</span>}
    {!compact && <p className="leading-relaxed">{t('apps.undeploy.hint', '线上应用将停止服务。代码、会话、数据库和上传文件会保留，之后可重新部署。')}</p>}
    {['uninstalling', 'uninstalled', 'uninstall_failed'].includes(current.fcStatus ?? '') && <p role="status" className="flex min-w-0 items-center gap-1.5 break-words font-medium text-foreground">
      {current.fcStatus === 'uninstalling' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : current.fcStatus === 'uninstalled' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5 text-destructive" />}
      {current.fcStatus === 'uninstalling' ? t('apps.undeploy.running', '卸载中…') : current.fcStatus === 'uninstalled' ? t('apps.undeploy.done', '已卸载') : t('apps.undeploy.incomplete', '清理未完成')}
    </p>}
    {!compact && Object.keys(current.undeployOperation?.steps ?? {}).length > 0 && <details open={current.fcStatus === 'uninstall_failed' || current.fcStatus === 'uninstalling'} className="rounded-[8px] border border-border-soft bg-background px-3 py-2">
      <summary className="cursor-pointer text-[12px] text-muted-foreground">{t('apps.undeploy.details', '查看清理详情')}</summary>
      <dl className="mt-2 space-y-2 text-[12px]">
        {Object.entries(current.undeployOperation?.steps ?? {}).map(([key, step]) => <div key={key}>
          <div className="flex items-center justify-between gap-3">
            <dt>{t(`apps.undeploy.${key}`, key)}</dt>
            <dd className={step.status === 'failed' ? 'text-destructive' : 'text-foreground'}>{t(`apps.undeploy.${step.status === 'failed' ? 'stepFailed' : step.status}`, step.status)}</dd>
          </div>
          {step.error && <p className="mt-1 break-words text-destructive">{step.error}</p>}
        </div>)}
      </dl>
    </details>}
    {current.undeployOperation?.error && <p role="alert">{current.undeployOperation.error}</p>}
    {readError && <p role="alert">{t('apps.undeploy.checkFailed', '无法读取卸载状态，请刷新重试。')}</p>}
    {current.canManageDeployment === true && current.fcStatus === 'uninstalled' && !compact && <Button variant="outline" size="sm" className="h-8 rounded-[7px] text-[12px]" disabled={pending || readError} onClick={() => void deploy(app.id)}>{t('apps.undeploy.redeploy', '重新部署')}</Button>}
    {current.canManageDeployment === true && current.fcStatus !== 'uninstalled' && !(compact && current.fcStatus === 'uninstalling') && <Button variant={compact ? "ghost" : "outline"} size="sm" className={compact ? "h-auto p-0 text-[11.5px] font-normal hover:bg-transparent hover:underline underline-offset-2" : "mt-1 h-8 rounded-[7px] text-[12px]"} disabled={pending || conflict || !deployed || readError} onClick={() => setOpen(true)}>
      {current.fcStatus === 'uninstall_failed' ? t('apps.undeploy.retry', '重试清理') : t('apps.undeploy.title', '卸载部署')}
    </Button>}
    <AlertDialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <AlertDialogContent size="sm"><AlertDialogHeader>
        <AlertDialogTitle>{t('apps.undeploy.confirm', '卸载线上部署？')}</AlertDialogTitle>
        <AlertDialogDescription>{app.name} — {t('apps.undeploy.hint', '线上应用将停止服务。代码、会话、数据库和上传文件会保留，之后可重新部署。')}</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{t('common.cancel', '取消')}</AlertDialogCancel>
        <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void approve() }}>{t('apps.undeploy.accept', '确认卸载')}</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>
}
