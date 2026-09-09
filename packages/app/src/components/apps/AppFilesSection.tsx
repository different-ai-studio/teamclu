import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileUp, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getBackend } from '@/lib/backend'
import type { AppFile, AppRow, AppStorageUsage } from '@/lib/backend/types'

interface AppFilesSectionProps {
  app: AppRow
  /** `admin` on this app: may also purge. Upload/delete need only `prompt`,
   *  and the server reports that per-app as `canWrite`. */
  canManage: boolean
}

/** Bytes for humans. Deliberately not a dependency; three lines. */
function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/**
 * The app's files, in the control panel.
 *
 * Uploads go browser -> storage directly on a signed URL; the bytes never pass
 * through the API. That is also why the list can be stale the instant an app
 * writes a file of its own, and why the usage line carries its own refresh
 * rather than pretending to be live.
 */
export function AppFilesSection({ app, canManage }: AppFilesSectionProps) {
  const { t } = useTranslation()
  const [state, setState] = React.useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = React.useState<string | null>(null)
  const [files, setFiles] = React.useState<AppFile[]>([])
  const [canWrite, setCanWrite] = React.useState(false)
  const [usage, setUsage] = React.useState<AppStorageUsage | null>(null)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const load = React.useCallback(async () => {
    setState('loading')
    try {
      const [page, u] = await Promise.all([
        getBackend().apps.listAppFiles(app.id, { limit: 100 }),
        getBackend().apps.getAppStorageUsage(app.id),
      ])
      if (!page) {
        // 404 is also what a `view`-less member gets, so this is "nothing to
        // show here", not an error worth a red message.
        setFiles([])
        setCanWrite(false)
        setState('ready')
        return
      }
      setFiles(page.items)
      setCanWrite(page.canWrite)
      setUsage(u)
      setState('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [app.id])

  React.useEffect(() => {
    void load()
  }, [load])

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const signed = await getBackend().apps.createAppFileUploadUrl(app.id, {
        path: file.name,
        contentType: file.type || null,
      })
      if (!signed) throw new Error(t('apps.files.uploadRefused', '没有上传权限'))
      const res = await fetch(signed.url, { method: 'PUT', body: file })
      if (!res.ok) throw new Error(`storage returned ${res.status}`)
      toast.success(t('apps.files.uploaded', '已上传 {{name}}', { name: file.name }))
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const download = async (path: string) => {
    try {
      const signed = await getBackend().apps.createAppFileDownloadUrl(app.id, path)
      if (!signed) throw new Error(t('apps.files.missing', '文件不存在'))
      window.open(signed.url, '_blank', 'noopener')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (path: string) => {
    setBusy(true)
    try {
      await getBackend().apps.deleteAppFile(app.id, path)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshUsage = async () => {
    setBusy(true)
    try {
      setUsage(await getBackend().apps.refreshAppStorageUsage(app.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const purge = async () => {
    // No confirm dialog is skipped here on purpose: deleting the app keeps its
    // files, so this is the only irreversible way to lose them.
    if (!window.confirm(t('apps.files.purgeConfirm', '删除这个应用的全部文件？无法恢复。'))) return
    setBusy(true)
    try {
      const out = await getBackend().apps.purgeAppFiles(app.id)
      toast.success(t('apps.files.purged', '已删除 {{count}} 个文件', { count: out?.deleted ?? 0 }))
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-files-state-unavailable">
        {t('apps.files.unavailable', '暂时无法访问这个应用的文件：{{reason}}', { reason: error })}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="app-files-section">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
          {usage?.bytes == null
            ? t('apps.files.neverMeasured', '{{count}} 个文件 · 用量未统计', { count: files.length })
            : t('apps.files.usage', '{{count}} 个文件 · 已用 {{used}}{{quota}}', {
                count: files.length,
                used: formatBytes(usage.bytes),
                quota: usage.quotaBytes ? ` / ${formatBytes(usage.quotaBytes)}` : '',
              })}
        </span>
        <div className="flex shrink-0 gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[11.5px]"
            disabled={busy}
            onClick={() => void refreshUsage()}
            data-testid="app-files-refresh-usage"
          >
            {t('apps.files.refreshUsage', '重新统计')}
          </Button>
          {canWrite && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 rounded-[7px] px-2.5 text-[11.5px]"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              data-testid="app-files-upload"
            >
              <FileUp className="h-3 w-3" />
              {t('apps.files.upload', '上传')}
            </Button>
          )}
        </div>
      </div>

      {usage?.overQuota && (
        <p className="text-[11.5px] text-destructive" data-testid="app-files-over-quota">
          {t(
            'apps.files.overQuota',
            '已超出配额，应用暂时无法写入新文件。用量为周期统计，可能滞后。',
          )}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void upload(f)
        }}
      />

      {files.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground" data-testid="app-files-empty">
          {t('apps.files.empty', '还没有文件。应用运行时写入的文件也会出现在这里。')}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {files.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-2 rounded-[6px] px-1.5 py-1 hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-[12px]" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-faint">{formatBytes(f.size)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                onClick={() => void download(f.path)}
                aria-label={t('apps.files.download', '下载')}
              >
                <Download className="h-3 w-3" />
              </Button>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0 text-destructive"
                  disabled={busy}
                  onClick={() => void remove(f.path)}
                  aria-label={t('apps.files.delete', '删除')}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && files.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[11.5px] text-destructive"
            disabled={busy}
            onClick={() => void purge()}
            data-testid="app-files-purge"
          >
            {t('apps.files.purge', '清空全部文件')}
          </Button>
        </div>
      )}
    </div>
  )
}
