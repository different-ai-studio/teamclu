import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Download,
  FileText,
  FileUp,
  Folder,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import type { AppFile, AppRow, AppStorageUsage } from '@/lib/backend/types'

interface AppFilesSectionProps {
  app: AppRow
  /** `admin` on this app: may also purge. Upload/delete need only `prompt`,
   *  and the server reports that per-app as `canWrite`. */
  canManage: boolean
}

/**
 * The app's files, browsed one folder at a time.
 *
 * An object store has no directories — what looks like a folder is every key
 * sharing a prefix up to the next `/`. Asking the store to collapse them
 * (`delimiter: "/"`) is what makes this a browser instead of a flat dump: an
 * app that writes `uploads/<user>/<file>` has thousands of keys and about six
 * things a person wants to look at.
 *
 * Uploads go browser -> storage directly on a signed URL; the bytes never pass
 * through the API. That is also why the list can be stale the instant an app
 * writes a file of its own, and why the usage line carries its own refresh
 * rather than pretending to be live.
 */

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

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i

/**
 * Why a direct-to-storage PUT failed before it ever got a response.
 *
 * The bytes go browser -> object store on a signed URL, so the store's bucket
 * has to permit this origin. When it does not, the browser blocks the request
 * at the CORS preflight and `fetch` rejects with a bare `TypeError` — "Failed
 * to fetch" on Chromium, "Load failed" in the WKWebView the desktop runs. Both
 * are indistinguishable from being offline, and neither tells the one person
 * who can fix it what to change.
 *
 * So the message names the likely cause and the origin that has to be allowed,
 * WITHOUT claiming to know which it was: a rejection here really can be the
 * network.
 */
function describeUploadFailure(e: unknown, t: (k: string, d: string, o?: Record<string, string>) => string): string {
  if (e instanceof TypeError) {
    return t(
      'apps.files.uploadBlocked',
      '浏览器没能把文件送到存储。最常见的原因是存储桶没有开启 CORS —— 需要允许来源 {{origin}} 的 PUT 请求。（也可能只是网络不通。）',
      { origin: typeof location !== 'undefined' ? location.origin : '' },
    )
  }
  return e instanceof Error ? e.message : String(e)
}

/**
 * Rows per request.
 *
 * Capped by the API, not by taste: every `/v1` list route runs its `limit`
 * through `parseLimit`, whose ceiling is 100 — anything above it is a 400, not a
 * clamp. Asking for 200 made the whole tab render "暂时无法访问这个应用的文件：
 * limit must be an integer from 1 to 100". Raising it means raising it there.
 */
const PAGE_SIZE = 100

/** The last segment of a path, which is what a browser row shows. */
export function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The trail from the app root to `prefix`, as [label, prefix] pairs.
 *
 * Built from the prefix rather than accumulated as the user clicks, so arriving
 * anywhere — a refresh, a deep link later — produces the same breadcrumb as
 * walking there.
 */
export function breadcrumbFor(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split('/').filter(Boolean)
  const out: { label: string; prefix: string }[] = []
  let acc = ''
  for (const part of parts) {
    acc += `${part}/`
    out.push({ label: part, prefix: acc })
  }
  return out
}

export function AppFilesSection({ app, canManage }: AppFilesSectionProps) {
  const { t } = useTranslation()
  const [prefix, setPrefix] = React.useState('')
  const [state, setState] = React.useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = React.useState<string | null>(null)
  const [files, setFiles] = React.useState<AppFile[]>([])
  const [folders, setFolders] = React.useState<string[]>([])
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [canWrite, setCanWrite] = React.useState(false)
  const [usage, setUsage] = React.useState<AppStorageUsage | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [confirmFolder, setConfirmFolder] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const load = React.useCallback(
    async (at: string) => {
      setState('loading')
      try {
        const [page, u] = await Promise.all([
          getBackend().apps.listAppFiles(app.id, { prefix: at, delimiter: '/', limit: PAGE_SIZE }),
          getBackend().apps.getAppStorageUsage(app.id),
        ])
        if (!page) {
          // 404 is also what a `view`-less member gets, so this is "nothing to
          // show here", not an error worth a red message.
          setFiles([])
          setFolders([])
          setNextCursor(null)
          setCanWrite(false)
          setState('ready')
          return
        }
        setFiles(page.items)
        setFolders(page.folders ?? [])
        setNextCursor(page.nextCursor)
        setCanWrite(page.canWrite)
        setUsage(u)
        setState('ready')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      }
    },
    [app.id],
  )

  React.useEffect(() => {
    void load(prefix)
  }, [load, prefix])

  const loadMore = async () => {
    if (!nextCursor) return
    setBusy(true)
    try {
      const page = await getBackend().apps.listAppFiles(app.id, {
        prefix,
        delimiter: '/',
        limit: PAGE_SIZE,
        after: nextCursor,
      })
      if (page) {
        setFiles((prev) => [...prev, ...page.items])
        setFolders((prev) => [...prev, ...(page.folders ?? [])])
        setNextCursor(page.nextCursor)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File) => {
    setBusy(true)
    try {
      // Into the folder being looked at, not the root — the alternative is an
      // upload button whose destination depends on nothing the user can see.
      const signed = await getBackend().apps.createAppFileUploadUrl(app.id, {
        path: `${prefix}${file.name}`,
        contentType: file.type || null,
      })
      if (!signed) throw new Error(t('apps.files.uploadRefused', '没有上传权限'))
      const res = await fetch(signed.url, { method: 'PUT', body: file })
      if (!res.ok) throw new Error(`storage returned ${res.status}`)
      toast.success(t('apps.files.uploaded', '已上传 {{name}}', { name: file.name }))
      await load(prefix)
    } catch (e) {
      toast.error(t('apps.files.uploadFailed', '上传失败'), {
        description: describeUploadFailure(e, t),
      })
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
      await load(prefix)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeFolder = async (folder: string) => {
    setBusy(true)
    try {
      const out = await getBackend().apps.deleteAppFolder(app.id, folder)
      if (!out) throw new Error(t('apps.files.folderDeleteRefused', '没有删除权限'))
      toast.success(t('apps.files.purged', '已删除 {{count}} 个文件', { count: out.deleted }))
      setConfirmFolder(null)
      await load(prefix)
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
      setPrefix('')
      await load('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'error') {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-files-state-unavailable">
        {t('apps.files.unavailable', '暂时无法访问这个应用的文件：{{reason}}', { reason: error })}
      </p>
    )
  }

  const crumbs = breadcrumbFor(prefix)

  return (
    <div className="flex flex-col gap-3" data-testid="app-files-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-[12.5px] text-muted-foreground">
          {usage?.bytes == null
            ? t('apps.files.neverMeasured', '用量未统计')
            : t('apps.files.usage', '已用 {{used}}{{quota}}', {
                used: formatBytes(usage.bytes),
                quota: usage.quotaBytes ? ` / ${formatBytes(usage.quotaBytes)}` : '',
              })}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-[7px] px-2 text-[12px]"
            disabled={busy}
            onClick={() => void load(prefix)}
            data-testid="app-files-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('common.refresh', '刷新')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-[7px] px-2 text-[12px]"
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
              className="h-8 gap-1.5 rounded-[7px] px-2.5 text-[12px]"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              data-testid="app-files-upload"
            >
              <FileUp className="h-3.5 w-3.5" />
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

      <nav className="flex flex-wrap items-center gap-0.5 text-[12px]" data-testid="app-files-breadcrumb">
        <button
          type="button"
          className={cn(
            'rounded-[5px] px-1.5 py-0.5 hover:bg-surface-2',
            prefix ? 'text-muted-foreground' : 'font-medium text-foreground',
          )}
          onClick={() => setPrefix('')}
        >
          {t('apps.files.root', '全部文件')}
        </button>
        {crumbs.map((crumb, i) => (
          <React.Fragment key={crumb.prefix}>
            <ChevronRight className="h-3 w-3 shrink-0 text-faint" />
            <button
              type="button"
              className={cn(
                'max-w-[200px] truncate rounded-[5px] px-1.5 py-0.5 hover:bg-surface-2',
                i === crumbs.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
              onClick={() => setPrefix(crumb.prefix)}
            >
              {crumb.label}
            </button>
          </React.Fragment>
        ))}
      </nav>

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

      <div className="overflow-hidden rounded-lg border border-border-soft">
        <div className="flex items-center gap-3 border-b border-border-soft bg-surface-2/40 px-3 py-2 text-[11px] font-medium text-faint">
          <span className="min-w-0 flex-1">{t('apps.files.colName', '名称')}</span>
          <span className="w-[72px] shrink-0 text-right">{t('apps.files.colModified', '修改时间')}</span>
          <span className="w-[80px] shrink-0 text-right">{t('apps.files.colSize', '大小')}</span>
          <span className="w-[64px] shrink-0" aria-hidden />
        </div>

        {state === 'loading' ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : folders.length === 0 && files.length === 0 ? (
          <p className="px-3 py-4 text-[12.5px] text-muted-foreground" data-testid="app-files-empty">
            {prefix
              ? t('apps.files.emptyFolder', '这个文件夹是空的。')
              : t('apps.files.empty', '还没有文件。应用运行时写入的文件也会出现在这里。')}
          </p>
        ) : (
          <ul className="divide-y divide-border-soft">
            {/* Folders first, the way every file browser orders them — they are
                navigation, and mixing them into an alphabetical run of files
                makes the way deeper into the tree something you hunt for. */}
            {folders.map((folder) => (
              <li
                key={folder}
                className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2"
                data-testid="app-files-folder"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setPrefix(folder)}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="min-w-0 truncate text-[12.5px] text-foreground">
                    {baseName(folder)}
                  </span>
                </button>
                <span className="w-[72px] shrink-0 text-right text-[11.5px] text-faint">—</span>
                <span className="w-[80px] shrink-0 text-right text-[11.5px] text-faint">—</span>
                <span className="flex w-[64px] shrink-0 justify-end">
                  {canWrite && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      disabled={busy}
                      onClick={() => setConfirmFolder(folder)}
                      aria-label={t('apps.files.deleteFolder', '删除文件夹')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </span>
              </li>
            ))}

            {files.map((f) => {
              const Icon = IMAGE_RE.test(f.path) ? ImageIcon : FileText
              return (
                <li
                  key={f.path}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2"
                  data-testid="app-files-file"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 truncate text-[12.5px]" title={f.path}>
                      {baseName(f.path)}
                    </span>
                  </span>
                  <span className="w-[72px] shrink-0 text-right text-[11.5px] tabular-nums text-faint">
                    {formatWhen(f.lastModified)}
                  </span>
                  <span className="w-[80px] shrink-0 text-right text-[11.5px] tabular-nums text-faint">
                    {formatBytes(f.size)}
                  </span>
                  <span className="flex w-[64px] shrink-0 justify-end gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void download(f.path)}
                      aria-label={t('apps.files.download', '下载')}
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                    {canWrite && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        disabled={busy}
                        onClick={() => void remove(f.path)}
                        aria-label={t('apps.files.delete', '删除')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 self-start rounded-[7px] text-[12px]"
          disabled={busy}
          onClick={() => void loadMore()}
          data-testid="app-files-load-more"
        >
          {t('apps.data.loadMore', '加载更多')}
        </Button>
      )}

      {canManage && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-[7px] px-2 text-[11.5px] text-destructive"
            disabled={busy}
            onClick={() => void purge()}
            data-testid="app-files-purge"
          >
            {t('apps.files.purge', '清空全部文件')}
          </Button>
        </div>
      )}

      <AlertDialog
        open={confirmFolder !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmFolder(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogTitle>
            {t('apps.files.deleteFolderTitle', '删除「{{name}}」整个文件夹？', {
              name: confirmFolder ? baseName(confirmFolder) : '',
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'apps.files.deleteFolderConfirm',
              '它下面的所有文件，包括子文件夹里的，都会被删掉。无法恢复。',
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                if (confirmFolder) void removeFolder(confirmFolder)
              }}
              data-testid="app-files-folder-delete-confirm"
            >
              {t('common.delete', '删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
