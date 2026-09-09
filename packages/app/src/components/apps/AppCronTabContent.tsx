import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { History, Loader2, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import { AppTabShell } from './AppTabShell'
import type {
  AppCronJob,
  AppCronJobInput,
  AppCronRun,
  AppRow,
} from '@/lib/backend/types'

/**
 * Cloud-scheduled requests against the deployed site.
 *
 * These run in the cloud, not on this machine — that is the whole reason they
 * exist next to the desktop's own cron, which schedules agent turns and stops
 * when the laptop closes. A task here is one HTTP request to one path of this
 * app, at a time the platform keeps.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

/**
 * Schedules people actually ask for, plus the escape hatch.
 *
 * A cron expression is the storage format, not the question — "every morning at
 * nine" should not require knowing which field is which. The custom option
 * keeps the full expression available for the cases the presets do not cover.
 */
const PRESETS: Array<{ key: string; expr: string; label: string }> = [
  { key: 'every5m', expr: '*/5 * * * *', label: '每 5 分钟' },
  { key: 'hourly', expr: '0 * * * *', label: '每小时整点' },
  { key: 'daily9', expr: '0 9 * * *', label: '每天 09:00' },
  { key: 'weekdays9', expr: '0 9 * * 1-5', label: '工作日 09:00' },
  { key: 'mondays9', expr: '0 9 * * 1', label: '每周一 09:00' },
  { key: 'monthly1', expr: '0 9 1 * *', label: '每月 1 号 09:00' },
]

/** Read by `t` as the fallback, so a run's verdict is legible in the source. */
const STATUS_FALLBACKS: Record<string, string> = {
  success: '成功',
  failed: '失败',
  timeout: '超时',
}

/** The zone the user is in, so a preset means what it looks like. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AppCronTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell
      appId={appId}
      title={t('apps.cron.tabTitle', '定时任务')}
      description={t(
        'apps.cron.tabDescription',
        '到点由云端向这个应用发一个请求，本机关机照跑。请求不带登录身份 —— 目标页面要么是公开的，要么用下面的自定义 header 自己校验。',
      )}
    >
      {(app) => <CronBody app={app} />}
    </AppTabShell>
  )
}

function CronBody({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const [jobs, setJobs] = React.useState<AppCronJob[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [canManage, setCanManage] = React.useState(false)
  const [editing, setEditing] = React.useState<AppCronJob | 'new' | null>(null)
  const [historyFor, setHistoryFor] = React.useState<AppCronJob | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState<AppCronJob | null>(null)
  const invalidateAppSummary = useAppsStore((s) => s.invalidateAppSummary)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [list, grants] = await Promise.all([
        getBackend().apps.listAppCronJobs(app.id),
        getBackend().apps.listAppAccess(app.id),
      ])
      setJobs(list ?? [])
      // Reading the grant list is `admin`-only, which is the same tier that may
      // change a schedule — so its success is the answer, with no second call.
      setCanManage(grants !== null)
    } catch (e) {
      console.error('[AppCronTab] failed to load', e)
      setJobs([])
      setCanManage(false)
    } finally {
      setLoading(false)
    }
  }, [app.id])

  React.useEffect(() => {
    void load()
  }, [load])

  const failed = (e: unknown) =>
    toast.error(t('apps.cron.error', '定时任务操作失败'), {
      description: e instanceof Error ? e.message : String(e),
    })

  const save = async (input: AppCronJobInput, job: AppCronJob | 'new') => {
    try {
      const saved =
        job === 'new'
          ? await getBackend().apps.createAppCronJob(app.id, input)
          : await getBackend().apps.updateAppCronJob(app.id, job.id, input)
      if (!saved) throw new Error(t('apps.cron.notAllowed', '没有权限修改这个应用的定时任务'))
      setJobs((prev) => {
        const list = prev ?? []
        const idx = list.findIndex((j) => j.id === saved.id)
        if (idx < 0) return [...list, saved]
        const next = [...list]
        next[idx] = saved
        return next
      })
      setEditing(null)
      // The panel counts these; it loads them once per app selection.
      invalidateAppSummary()
    } catch (e) {
      failed(e)
    }
  }

  const toggle = async (job: AppCronJob, enabled: boolean) => {
    setBusyId(job.id)
    try {
      const saved = await getBackend().apps.updateAppCronJob(app.id, job.id, { enabled })
      if (!saved) {
        // 404 is "gone, or no longer yours". Dropping it left the switch
        // snapped back with nothing said.
        failed(new Error(t('apps.cron.notAllowed', '没有权限修改这个应用的定时任务')))
        return
      }
      setJobs((prev) => (prev ?? []).map((j) => (j.id === saved.id ? saved : j)))
    } catch (e) {
      failed(e)
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (job: AppCronJob) => {
    setBusyId(job.id)
    try {
      const out = await getBackend().apps.runAppCronJobNow(app.id, job.id)
      if (!out) throw new Error(t('apps.cron.notAllowed', '没有权限修改这个应用的定时任务'))
      if (out.status === 'success') {
        toast.success(t('apps.cron.ranOk', '跑完了 —— 应用返回 {{status}}', {
          status: out.responseStatus ?? 200,
        }))
      } else {
        // The failure text is the useful part (it names the login wall by the
        // tab that fixes it), so it goes in the description, not truncated.
        toast.error(t('apps.cron.ranFailed', '这一次没跑成功'), {
          description: out.error ?? undefined,
        })
      }
    } catch (e) {
      failed(e)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (job: AppCronJob) => {
    setBusyId(job.id)
    try {
      const ok = await getBackend().apps.deleteAppCronJob(app.id, job.id)
      if (!ok) {
        failed(new Error(t('apps.cron.deleteFailed', '删不掉 —— 它可能已经被删了，或者你已经没有权限。')))
        return
      }
      setJobs((prev) => (prev ?? []).filter((j) => j.id !== job.id))
      setConfirmDelete(null)
      invalidateAppSummary()
    } catch (e) {
      failed(e)
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  const list = jobs ?? []

  return (
    <div className="space-y-4" data-testid="app-cron-tab">
      {list.length === 0 ? (
        <p className="text-[13px] text-muted-foreground" data-testid="app-cron-empty">
          {t('apps.cron.empty', '还没有定时任务。')}
        </p>
      ) : (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {list.map((job) => (
            <li key={job.id} className="flex items-center gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left text-[13px] font-medium text-foreground hover:underline disabled:cursor-default disabled:no-underline"
                    disabled={!canManage}
                    onClick={() => setEditing(job)}
                  >
                    {job.name}
                  </button>
                  <span className="shrink-0 rounded-[5px] bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                    {job.method} {job.path}
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
                  {job.schedule} · {job.timezone}
                </p>
                <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                  {job.enabled
                    ? job.nextRunAt
                      ? t('apps.cron.nextRun', '下次 {{when}}', {
                          when: formatWhen(job.nextRunAt),
                        })
                      : // A null next run on an ENABLED job is not "soon": the
                        // expression names a date that never comes.
                        t('apps.cron.never', '这个表达式永远不会到')
                    : t('apps.cron.disabled', '已停用')}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  onClick={() => setHistoryFor(job)}
                  title={t('apps.cron.history', '执行记录')}
                >
                  <History className="h-3.5 w-3.5" />
                </Button>
                {canManage && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      disabled={busyId === job.id}
                      onClick={() => void runNow(job)}
                      title={t('apps.cron.runNow', '立即跑一次')}
                      data-testid="app-cron-run-now"
                    >
                      {busyId === job.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Switch
                      checked={job.enabled}
                      disabled={busyId === job.id}
                      onCheckedChange={(v) => void toggle(job, v)}
                      aria-label={t('apps.cron.enabled', '启用')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      disabled={busyId === job.id}
                      onClick={() => setConfirmDelete(job)}
                      title={t('common.delete', '删除')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 rounded-[7px] text-[13px]"
          onClick={() => setEditing('new')}
          data-testid="app-cron-new"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('apps.cron.new', '新建定时任务')}
        </Button>
      ) : (
        <p className="text-[12.5px] text-muted-foreground" data-testid="app-cron-readonly">
          {t('apps.cron.readOnly', '仅创建者或 admin 可以增删改定时任务。')}
        </p>
      )}

      {editing && (
        <JobDialog
          job={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={(input) => save(input, editing)}
        />
      )}

      {historyFor && (
        <HistoryDialog app={app} job={historyFor} onClose={() => setHistoryFor(null)} />
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('apps.cron.deleteTitle', '删除这个定时任务？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('apps.cron.deleteConfirm', '它的执行记录也会一起删掉。这个操作无法撤销。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              {t('common.delete', '删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function JobDialog({
  job,
  onCancel,
  onSave,
}: {
  job: AppCronJob | null
  onCancel: () => void
  onSave: (input: AppCronJobInput) => Promise<void>
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(job?.name ?? '')
  const [schedule, setSchedule] = React.useState(job?.schedule ?? '0 9 * * *')
  const [timezone, setTimezone] = React.useState(job?.timezone ?? localTimeZone())
  const [method, setMethod] = React.useState(job?.method ?? 'GET')
  const [path, setPath] = React.useState(job?.path ?? '/')
  const [headersText, setHeadersText] = React.useState(
    Object.entries(job?.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  )
  const [body, setBody] = React.useState(job?.body ?? '')
  const [saving, setSaving] = React.useState(false)

  const preset = PRESETS.find((p) => p.expr === schedule)?.key ?? 'custom'
  const bodyAllowed = method !== 'GET' && method !== 'HEAD'

  /** `Name: value` per line — the shape people already paste out of curl. */
  const parseHeaders = (): Record<string, string> | null => {
    const out: Record<string, string> = {}
    for (const line of headersText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const colon = trimmed.indexOf(':')
      if (colon <= 0) return null
      out[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
    }
    return out
  }

  const headers = parseHeaders()
  const valid = name.trim() && schedule.trim() && path.startsWith('/') && headers !== null

  const submit = async () => {
    if (!valid || !headers) return
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        schedule: schedule.trim(),
        timezone,
        method,
        path: path.trim(),
        headers,
        body: bodyAllowed && body ? body : null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {job ? t('apps.cron.editTitle', '编辑定时任务') : t('apps.cron.new', '新建定时任务')}
          </AlertDialogTitle>
        </AlertDialogHeader>

        <div className="space-y-3">
          <Field label={t('apps.cron.name', '名称')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apps.cron.namePlaceholder', '每天生成日报')}
              className="h-9 rounded-[7px] text-[13px]"
              disabled={saving}
            />
          </Field>

          <Field label={t('apps.cron.schedule', '什么时候跑')}>
            <div className="flex flex-wrap gap-2">
              <Select
                value={preset}
                onValueChange={(v) => {
                  const found = PRESETS.find((p) => p.key === v)
                  if (found) setSchedule(found.expr)
                }}
                disabled={saving}
              >
                <SelectTrigger className="h-9 min-w-[180px] flex-1 rounded-[7px] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key} className="text-[13px]">
                      {t(`apps.cron.preset.${p.key}`, p.label)}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom" className="text-[13px]">
                    {t('apps.cron.preset.custom', '自定义表达式')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 9 * * *"
                className="h-9 w-[150px] rounded-[7px] font-mono text-[12.5px]"
                disabled={saving}
                data-testid="app-cron-schedule"
              />
            </div>
            <p className="mt-1.5 text-[11.5px] text-faint">
              {t('apps.cron.scheduleHint', '五段式：分 时 日 月 周。时区：{{tz}}', {
                tz: timezone,
              })}
            </p>
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Asia/Shanghai"
              className="mt-1.5 h-9 rounded-[7px] font-mono text-[12.5px]"
              disabled={saving}
            />
          </Field>

          <Field label={t('apps.cron.request', '请求什么')}>
            <div className="flex gap-2">
              <Select value={method} onValueChange={setMethod} disabled={saving}>
                <SelectTrigger className="h-9 w-[104px] shrink-0 rounded-[7px] font-mono text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-[12px]">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/api/daily"
                className="h-9 flex-1 rounded-[7px] font-mono text-[12.5px]"
                disabled={saving}
                data-testid="app-cron-path"
              />
            </div>
            {!path.startsWith('/') && (
              <p className="mt-1.5 text-[11.5px] text-destructive">
                {t('apps.cron.pathMustStart', '只填路径，以 / 开头 —— 域名是这个应用自己的。')}
              </p>
            )}
          </Field>

          <Field label={t('apps.cron.headers', '自定义 header')}>
            <Textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={'X-Job-Secret: ...'}
              rows={2}
              className="rounded-[7px] font-mono text-[12px]"
              disabled={saving}
            />
            <p className="mt-1.5 text-[11.5px] text-faint">
              {t(
                'apps.cron.headersHint',
                '一行一个，写成 `名字: 值`。定时请求不带登录身份，要校验就在这里放一个自己的密钥。',
              )}
            </p>
            {headers === null && (
              <p className="mt-1 text-[11.5px] text-destructive">
                {t('apps.cron.headersInvalid', '有一行不是「名字: 值」的形式。')}
              </p>
            )}
          </Field>

          {bodyAllowed && (
            <Field label={t('apps.cron.body', '请求体')}>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                className="rounded-[7px] font-mono text-[12px]"
                disabled={saving}
              />
            </Field>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving || !valid}
            onClick={(e) => {
              e.preventDefault()
              void submit()
            }}
            data-testid="app-cron-save"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-medium text-faint">{label}</h4>
      {children}
    </div>
  )
}

function HistoryDialog({
  app,
  job,
  onClose,
}: {
  app: AppRow
  job: AppCronJob
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [runs, setRuns] = React.useState<AppCronRun[] | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await getBackend().apps.listAppCronRuns(app.id, job.id)
        if (!cancelled) setRuns(list ?? [])
      } catch {
        if (!cancelled) setRuns([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app.id, job.id])

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('apps.cron.history', '执行记录')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('apps.cron.historyHint', '只保留最近 20 次。')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {runs === null ? (
          <div className="flex items-center gap-2 py-3 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : runs.length === 0 ? (
          <p className="py-2 text-[13px] text-muted-foreground">
            {t('apps.cron.noRuns', '还没有跑过。')}
          </p>
        ) : (
          <ul className="max-h-[340px] space-y-1.5 overflow-auto">
            {runs.map((run) => (
              <li key={run.id} className="rounded-[7px] border border-border-soft px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[11px]',
                      run.status === 'success' ? 'text-[#2eb872]' : 'text-destructive',
                    )}
                  >
                    {t(`apps.cron.status.${run.status}`, STATUS_FALLBACKS[run.status] ?? run.status)}
                    {run.responseStatus ? ` ${run.responseStatus}` : ''}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">
                    {formatWhen(run.startedAt)}
                    {run.durationMs != null ? ` · ${run.durationMs}ms` : ''}
                  </span>
                </div>
                {run.error && (
                  <p className="mt-1 break-words text-[11.5px] text-muted-foreground">
                    {run.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.close', '关闭')}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
