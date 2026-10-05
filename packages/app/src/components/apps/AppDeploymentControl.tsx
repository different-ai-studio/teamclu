import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { getBackend } from '@/lib/backend/provider'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

/** Only server-resolved management permission exposes the destructive action. */
export function AppDeploymentControl({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const undeploy = useAppsStore(s => s.undeployApp)
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
  const pending = busy || current.fcStatus === 'uninstalling'
  const conflict = ['awaiting_build', 'building', 'deploying'].includes(current.fcStatus ?? '')
  const deployed = !!current.fcStatus && !['not_deployed', 'uninstalled'].includes(current.fcStatus)
  const approve = async () => {
    setBusy(true)
    try { if (await undeploy(app.id)) { setOpen(false); await refresh(app.id) } }
    finally { setBusy(false) }
  }
  return <div className="space-y-2 text-[12.5px] text-muted-foreground" data-testid="app-undeploy-control">
    {current.fcStatus === 'uninstalling' && <p role="status">{t('apps.undeploy.running', '卸载中…')}</p>}
    {current.fcStatus === 'uninstalled' && <p role="status">{t('apps.undeploy.done', '已卸载')}</p>}
    {current.fcStatus === 'uninstall_failed' && <p role="status">{t('apps.undeploy.incomplete', '清理未完成')}</p>}
    {Object.entries(current.undeployOperation?.steps ?? {}).map(([key, step]) => <p key={key}>
      {t(`apps.undeploy.${key}`, key)}：{t(`apps.undeploy.${step.status === 'failed' ? 'stepFailed' : step.status}`, step.status)}
      {step.error && <span className="ml-2">{step.error}</span>}
    </p>)}
    {current.undeployOperation?.error && <p role="alert">{current.undeployOperation.error}</p>}
    {readError && <p role="alert">{t('apps.undeploy.checkFailed', '无法读取卸载状态，请刷新重试。')}</p>}
    {current.canManageDeployment === true && <Button variant="outline" size="sm" disabled={pending || conflict || !deployed || readError} onClick={() => setOpen(true)}>
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
