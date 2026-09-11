import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Save,
  Pencil,
  X,
  Trash2,
  FolderInput,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { cn, copyToClipboard, isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { appStatusMeta, canReseed } from '@/lib/apps/app-list-helpers'
import { APP_TYPES, IMPORTED_APP_TYPE, resolveAppType, type AppTypeId } from '@/lib/apps/app-types'
import { daemonAppWorkdir, moveDaemonAppWorkdir } from '@/lib/daemon/daemon-local-client'
import {
  openAppSettings,
  openAppAccess,
  openAppAuth,
  openAppCron,
  openAppDataTable,
  openAppEnv,
  openAppFiles,
  openAppLogs,
} from '@/lib/tabs/app-tabs'
import { isGiteaManaged, useAppsStore } from '@/stores/apps-store'
import { AppCustomDomainSection } from './AppCustomDomainSection'
import type { AppGitHead, AppRow } from '@/lib/backend/types'

function StatusDot({ tone }: { tone: 'live' | 'ready' | 'failed' | 'idle' }) {
  const color =
    tone === 'live'
      ? 'bg-[#2eb872]'
      : tone === 'failed'
        ? 'bg-destructive'
        : tone === 'ready'
          ? 'bg-[#2eb872]/70'
          : 'bg-[#e8b54a]'
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', color)} />
}

/**
 * A flat group of related settings.
 *
 * No border and no background on purpose: the panel is a narrow column, and
 * boxing every group turned it into a stack of chrome with the actual controls
 * squeezed inside. The heading and the spacing carry the grouping instead.
 */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="[&+&]:mt-6">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-2">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** One labelled group inside a card. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border-soft/60 pt-3 first:border-t-0 first:pt-0 [&+&]:mt-3">
      <h4 className="mb-1.5 text-[11px] font-medium text-faint">{label}</h4>
      {children}
    </div>
  )
}

/**
 * One management surface, as a line: what it is, how much of it there is, and a
 * way in.
 *
 * The panel used to hold the controls themselves — a grant table, a rule
 * editor, a file list — inside 280px. Each of them needed a row, and a row
 * needs width, so each was cramped into a column of its own. Here the panel
 * answers only "how much is there", which is the question you can actually ask
 * of a narrow column, and the editing happens in a tab that has room.
 *
 * `value` is a count when there is one and a REASON when there is not
 * ("not deployed", "no database"). Zero and not-applicable are different
 * answers and showing both as "0" loses the difference.
 */
function SummaryRow({
  label,
  value,
  loading,
  onOpen,
  testId,
  disabled = false,
  description,
}: {
  disabled?: boolean
  description?: string
  label: string
  value: string | null
  loading?: boolean
  onOpen: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled || loading}
      data-testid={testId}
      className="flex w-full items-center gap-2 rounded-[7px] px-1.5 py-2 text-left transition-colors enabled:hover:bg-panel disabled:cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="min-w-0 text-[13px] text-foreground">
        {label}
        {description && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground">
        {loading ? <Loader2 className="ml-auto h-3 w-3 animate-spin" /> : value}
      </span>
      <ChevronRight
        className={cn('h-3.5 w-3.5 shrink-0 text-faint', (disabled || loading) && 'invisible')}
      />
    </button>
  )
}

/**
 * Whether changing visibility to `next` needs to be confirmed first.
 *
 * Only narrowing does. Widening a personal app to the team can surprise nobody
 * — it adds people to a list. Narrowing takes the app off every teammate's
 * list, and the word "personal" does not say that on its own.
 *
 * Exported because the rule is the interesting part and a Radix Select cannot
 * be opened in jsdom to reach it through the UI.
 */
export function visibilityChangeNeedsConfirm(
  current: AppRow['visibility'],
  next: AppRow['visibility'],
): boolean {
  if (current === next) return false
  return next === 'personal'
}

/** Every type an app can be: the three the create dialog offers, then imported. */
const SELECTABLE_APP_TYPES = [...APP_TYPES, IMPORTED_APP_TYPE]

/** Named in the leave-database confirm as the way back. */
const DATA_APP_TYPE = resolveAppType('data_app')

/**
 * Whether changing the app's type from `current` to `next` needs confirming.
 *
 * Only leaving a type that has a database for one that does not. Nothing is
 * lost on the spot — the running site keeps its DATABASE_URL until the next
 * deploy, and the data stays where it is — but that next deploy takes the
 * variable away and every query the code makes starts failing, and a type
 * label says nothing about any of that. Every other change either adds a
 * database or never had one to lose.
 *
 * Takes raw stored values so a legacy type reads as the data app it is.
 * Exported for the same reason as `visibilityChangeNeedsConfirm`.
 */
export function typeChangeNeedsConfirm(
  current: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const from = resolveAppType(current)
  const to = resolveAppType(next)
  if (from.id === to.id) return false
  return from.needsDatabase && !to.needsDatabase
}

/** Seven characters is what every git UI shows and what people paste. */
const shortSha = (sha: string) => sha.slice(0, 7)

/**
 * What the code-version line says, given the app row and the branch head.
 *
 * Split out because there are five states and only one of them is the happy
 * path — the interesting ones are "never deployed", "we cannot see the branch"
 * and "we can see it but cannot count the distance". Each needs different
 * words, and none of them should render as a blank line.
 */
export function describeCodeVersion(
  app: Pick<AppRow, 'gitCommitSha' | 'gitAuthKind' | 'fcStatus'>,
  head: AppGitHead | null,
): { key: string; fallback: string; vars?: Record<string, string | number> } {
  if (!isGiteaManaged(app)) {
    return {
      key: 'apps.controlPanel.codeVersionExternalRepo',
      fallback: '这个应用用的是外部仓库，看不到它的分支。',
    }
  }
  if (!head) {
    return {
      key: 'apps.controlPanel.codeVersionUnavailable',
      fallback: '暂时读不到仓库',
    }
  }
  if (!head.deployedSha) {
    return {
      key: 'apps.controlPanel.codeVersionNeverDeployed',
      fallback: '还没有部署过 · 分支 {{branch}} 在 {{head}}',
      vars: { branch: head.branch, head: shortSha(head.sha) },
    }
  }
  // `apps.git_commit_sha` is stamped when a deploy STARTS, not when it
  // finishes, so on anything but a live app it names the commit the last deploy
  // ATTEMPTED — not what is serving. A failed build would otherwise have the
  // panel print "线上 abc123 · 已是最新" while the function still ran the commit
  // before it, and the operator would read "nothing to deploy" and stop looking.
  if (app.fcStatus !== 'live') {
    return {
      key: 'apps.controlPanel.codeVersionNotLive',
      fallback: '上次部署的是 {{sha}}，但没有成功上线 · 分支 {{branch}} 在 {{head}}',
      vars: {
        sha: shortSha(head.deployedSha),
        branch: head.branch,
        head: shortSha(head.sha),
      },
    }
  }
  if (head.undeployedCommits === 0 || head.deployedSha === head.sha) {
    return {
      key: 'apps.controlPanel.codeVersionUpToDate',
      fallback: '线上 {{sha}} · 已是分支 {{branch}} 的最新',
      vars: { sha: shortSha(head.deployedSha), branch: head.branch },
    }
  }
  if (head.undeployedCommits === null) {
    // The forge could not compare them. Saying "有更新" without a number is
    // honest; inventing one, or falling back to "up to date", is not.
    return {
      key: 'apps.controlPanel.codeVersionBehindUnknown',
      fallback: '线上 {{sha}} · 分支 {{branch}} 上有没部署的改动',
      vars: { sha: shortSha(head.deployedSha), branch: head.branch },
    }
  }
  return {
    key: 'apps.controlPanel.codeVersionBehind',
    fallback: '线上 {{sha}} · 分支 {{branch}} 上还有 {{count}} 个提交没部署',
    vars: {
      sha: shortSha(head.deployedSha),
      branch: head.branch,
      count: head.undeployedCommits,
    },
  }
}

/** Bytes for humans. Deliberately not a dependency; three lines. */
function formatBytes(n: number | null | undefined): string | null {
  if (n == null) return null
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

interface Summary {
  members: number | null
  // `first` rides along so opening the browser does not re-ask the server which
  // tables exist; the browser has its own switcher and only needs a starting
  // point.
  tables:
    | { count: number; first: string | null }
    | { reason: 'no_database' | 'not_deployed' | 'unavailable' }
    | null
  files: { count: number; more: boolean; bytes: number | null } | null
  cronJobs: number | null
  env: { count: number; secrets: number } | null
  /** Null for an app whose repo is not ours to read (see isGiteaManaged). */
  gitHead: AppGitHead | null
}

/**
 * Every count the panel shows, in one pass.
 *
 * `allSettled`, not `all`: these are four independent surfaces and one of them
 * being unreachable (an app with no database, a storage bucket that is not
 * configured) must not blank the other three.
 */
function useAppSummary(app: AppRow, enabled: boolean): { summary: Summary; loading: boolean } {
  const managed = isGiteaManaged(app)
  // Re-run when a tab reports it changed something these counts describe.
  const revision = useAppsStore((s) => s.summaryRevision)
  const [summary, setSummary] = React.useState<Summary>({
    members: null,
    tables: null,
    files: null,
    cronJobs: null,
    env: null,
    gitHead: null,
  })
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    setSummary({
      members: null,
      tables: null,
      files: null,
      cronJobs: null,
      env: null,
      gitHead: null,
    })

    void (async () => {
      const backend = getBackend().apps
      const [access, tables, files, usage, cron, env, gitHead] = await Promise.allSettled([
        backend.listAppAccess(app.id),
        backend.listAppDataTables(app.id),
        // No delimiter on purpose: this is a COUNT, and one level of the root
        // folder is not the answer to "how many files does this app have".
        backend.listAppFiles(app.id, { limit: 100 }),
        backend.getAppStorageUsage(app.id),
        backend.listAppCronJobs(app.id),
        backend.listAppEnv(app.id),
        // Only for a repo we host: an imported app's branch is on someone
        // else's forge and this deployment holds no credential for it.
        managed ? backend.getGitHead(app.id, { compare: true }) : Promise.resolve(null),
      ])
      if (cancelled) return

      const filesPage = files.status === 'fulfilled' ? files.value : null
      setSummary({
        members: access.status === 'fulfilled' ? (access.value?.length ?? null) : null,
        tables:
          tables.status === 'fulfilled' && tables.value
            ? tables.value.status === 'ok'
              ? {
                  count: tables.value.tables.length,
                  first: tables.value.tables[0]?.name ?? null,
                }
              : { reason: tables.value.status }
            : null,
        files: filesPage
          ? {
              count: filesPage.items.length,
              // One page was fetched; a further page means the count is a
              // floor, not a total. Rendering "100 个文件" for an app with 500
              // is wrong in the direction that looks entirely plausible.
              more: Boolean(filesPage.nextCursor),
              bytes: usage.status === 'fulfilled' ? (usage.value?.bytes ?? null) : null,
            }
          : null,
        cronJobs: cron.status === 'fulfilled' ? (cron.value?.length ?? null) : null,
        env:
          env.status === 'fulfilled' && env.value
            ? {
                count: env.value.items.length,
                secrets: env.value.items.filter((v) => v.isSecret).length,
              }
            : null,
        gitHead: gitHead.status === 'fulfilled' ? gitHead.value : null,
      })
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [app.id, revision, enabled, managed])

  return { summary, loading }
}

interface AppControlPanelProps {
  app: AppRow
  settings?: boolean
}

export function AppControlPanel({ app, settings = false }: AppControlPanelProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const reseed = useAppsStore((s) => s.reseed)
  const setVisibility = useAppsStore((s) => s.setVisibility)
  const setType = useAppsStore((s) => s.setType)
  const rename = useAppsStore((s) => s.rename)
  const deleteApp = useAppsStore((s) => s.deleteApp)

  const [editingName, setEditingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(app.name)
  const [renaming, setRenaming] = React.useState(false)
  const [reseeding, setReseeding] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const [localWorkdir, setLocalWorkdir] = React.useState<string | null>(null)
  const [localDeviceName, setLocalDeviceName] = React.useState<string | null>(null)
  const [localPathLoading, setLocalPathLoading] = React.useState(false)
  const [moveOpen, setMoveOpen] = React.useState(false)
  const [moveDest, setMoveDest] = React.useState('')
  const [moving, setMoving] = React.useState(false)
  const [visibilityPending, setVisibilityPending] = React.useState<'personal' | 'team' | null>(null)
  const [visibilitySaving, setVisibilitySaving] = React.useState(false)
  // Open state and target are separate so the target's name stays on the
  // confirm button while the dialog animates closed after a success.
  const [typeConfirmOpen, setTypeConfirmOpen] = React.useState(false)
  const [typeTarget, setTypeTarget] = React.useState<AppTypeId | null>(null)
  const [typeSaving, setTypeSaving] = React.useState(false)

  const { summary, loading: summaryLoading } = useAppSummary(app, !settings)
  // Resolved, not raw: a legacy stored type has to land on 数据操作 in the
  // Select, or the trigger would render blank for every pre-split app.
  const appType = resolveAppType(app.type)
  const typeTargetMeta = typeTarget ? resolveAppType(typeTarget) : null

  React.useEffect(() => {
    setNameDraft(app.name)
  }, [app.id, app.name])

  const status = appStatusMeta(app, deploying)
  const showReseed = canReseed(app.provisionStatus)

  const loadLocalPath = React.useCallback(async () => {
    if (!isTauri()) {
      setLocalWorkdir(null)
      setLocalDeviceName(null)
      return
    }
    setLocalPathLoading(true)
    try {
      const info = await daemonAppWorkdir(app.id, app.teamId)
      setLocalWorkdir(info?.workdir ?? null)
      setLocalDeviceName(info?.deviceName ?? null)
    } catch (e) {
      console.error('[AppControlPanel] failed to load local path', e)
      setLocalWorkdir(null)
      setLocalDeviceName(null)
    } finally {
      setLocalPathLoading(false)
    }
  }, [app.id, app.teamId])

  React.useEffect(() => {
    if (settings) void loadLocalPath()
  }, [loadLocalPath, settings])

  const handleRename = async () => {
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === app.name) return
    setRenaming(true)
    try {
      await rename(app.id, trimmed)
      setEditingName(false)
    } catch (error) {
      toast.error(String(error))
    } finally {
      setRenaming(false)
    }
  }

  const handleReseed = async () => {
    setReseeding(true)
    try {
      await reseed(app.id)
    } finally {
      setReseeding(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const ok = await deleteApp(app.id)
      if (ok) setDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  const handleMovePickFolder = async () => {
    if (!isTauri()) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('apps.controlPanel.moveDirectoryPick', '选择新的应用目录'),
      })
      if (typeof selected === 'string' && selected.trim()) {
        setMoveDest(selected.trim())
      }
    } catch (e) {
      toast.error(t('apps.controlPanel.moveDirectoryError', '移动目录失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleMoveConfirm = async () => {
    const dest = moveDest.trim()
    if (!dest) return
    setMoving(true)
    try {
      const result = await moveDaemonAppWorkdir(app.id, app.teamId, dest)
      if (result.outcome === 'moved') {
        setLocalWorkdir(result.workdir)
        // Re-bind the cloud workspace row too, not just local state. That row
        // is what runtime-start resolves to a path (see app-session.ts), so
        // leaving it on the old directory means any session already open keeps
        // running the agent against a path that no longer exists — until some
        // later session-open happens to re-bind it.
        if (result.workdir) {
          const { bindAppWorkdir } = await import('@/lib/apps/app-session')
          await bindAppWorkdir(app, result.workdir)
        }
        setMoveOpen(false)
        setMoveDest('')
        toast.success(t('apps.controlPanel.moveDirectoryDone', '目录已移动'))
      } else if (result.outcome === 'unreachable') {
        toast.error(t('apps.controlPanel.moveDirectoryUnreachable', '无法连接本机 daemon'))
      } else {
        toast.error(t('apps.controlPanel.moveDirectoryError', '移动目录失败'), {
          description: result.error ?? undefined,
        })
      }
    } finally {
      setMoving(false)
    }
  }

  const handleVisibility = async (next: 'personal' | 'team') => {
    setVisibilitySaving(true)
    try {
      const ok = await setVisibility(app.id, next)
      if (ok) setVisibilityPending(null)
    } finally {
      setVisibilitySaving(false)
    }
  }

  // The store recounts the summary on success — the data row's answer depends
  // on the type — so there is nothing to refresh here.
  const handleType = async (next: AppTypeId) => {
    setTypeSaving(true)
    try {
      const ok = await setType(app.id, next)
      if (ok) setTypeConfirmOpen(false)
    } finally {
      setTypeSaving(false)
    }
  }

  // --- what each summary row says ---------------------------------------------

  const membersValue =
    summary.members === null
      ? t('apps.controlPanel.summaryRestricted', '仅创建者可见')
      : t('apps.controlPanel.summaryMembers', '{{count}} 位成员', {
          count: summary.members,
        })

  const rulesValue = (() => {
    if (app.authMode !== 'platform') {
      return t('apps.controlPanel.summaryNoLogin', '不需要登录')
    }
    const count = app.authRules?.length ?? 0
    return count === 0
      ? t('apps.controlPanel.summaryAllPages', '全站一条规则')
      : t('apps.controlPanel.summaryRules', '{{count}} 条页面规则', { count })
  })()

  const tablesValue = (() => {
    const tables = summary.tables
    if (!tables) return t('apps.controlPanel.summaryUnavailable', '暂时读不到')
    if ('reason' in tables) {
      if (tables.reason === 'no_database') return t('apps.data.noDatabaseShort', '没有数据库')
      if (tables.reason === 'not_deployed')
        return t('apps.controlPanel.summaryNotDeployed', '未部署')
      return t('apps.controlPanel.summaryUnavailable', '暂时读不到')
    }
    return t('apps.controlPanel.summaryTables', '{{count}} 张表', {
      count: tables.count,
    })
  })()

  const filesValue = (() => {
    if (!summary.files) return t('apps.controlPanel.summaryUnavailable', '暂时读不到')
    const used = formatBytes(summary.files.bytes)
    const count = summary.files.more
      ? t('apps.controlPanel.summaryFilesMore', '{{count}}+ 个文件', {
          count: summary.files.count,
        })
      : t('apps.controlPanel.summaryFiles', '{{count}} 个文件', {
          count: summary.files.count,
        })
    return used ? `${count} · ${used}` : count
  })()

  const deployed = Boolean(app.fcStatus) && app.fcStatus !== 'not_deployed'
  const logsValue = deployed
    ? t('apps.logs.open', '查看日志')
    : t('apps.controlPanel.summaryNotDeployed', '未部署')

  const cronValue =
    summary.cronJobs === null
      ? t('apps.controlPanel.summaryUnavailable', '暂时读不到')
      : t('apps.controlPanel.summaryCronJobs', '{{count}} 个任务', {
          count: summary.cronJobs,
        })

  const envValue = (() => {
    if (!summary.env) return t('apps.controlPanel.summaryRestricted', '仅创建者可见')
    const count = t('apps.controlPanel.summaryEnvVars', '{{count}} 个变量', {
      count: summary.env.count,
    })
    // The secret count is worth its own clause: it is the part that cannot be
    // read back, so knowing how much of this app's config is write-only is a
    // different fact from knowing how much config there is.
    return summary.env.secrets > 0
      ? `${count} · ${t('apps.controlPanel.summarySecrets', '{{count}} 个密钥', {
          count: summary.env.secrets,
        })}`
      : count
  })()

  const openData = () => {
    // Still loading: the row shows a spinner, and the reason text has not been
    // decided yet. Saying "cannot read it right now" here would be a lie about
    // a request that is still in flight.
    if (summaryLoading) return
    const tables = summary.tables
    // "The first table" is as good a start as any — the browser switches from
    // there. With nothing to open, say why rather than opening an empty tab.
    if (tables && !('reason' in tables) && tables.first) {
      openAppDataTable(app, tables.first)
      return
    }
    toast.info(tablesValue)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {!settings && (
        <header className="shrink-0 border-b border-border-soft px-3.5 py-3">
          <div className="flex items-center gap-2">
            <StatusDot tone={status.dot} />
            {editingName ? (
              <form
                className="flex min-w-0 flex-1 gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleRename()
                }}
              >
                <Input
                  autoFocus
                  aria-label={t('apps.rename', '重命名')}
                  value={nameDraft}
                  disabled={renaming}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !renaming) setEditingName(false)
                  }}
                  className="h-7 min-w-0 text-[13px]"
                />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t('common.save', '保存')}
                  disabled={renaming || !nameDraft.trim() || nameDraft.trim() === app.name}
                >
                  {renaming ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  disabled={renaming}
                  aria-label={t('common.cancel', '取消')}
                  onClick={() => setEditingName(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </form>
            ) : (
              <>
                <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{app.name}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t('apps.rename', '重命名')}
                  onClick={() => {
                    setNameDraft(app.name)
                    setEditingName(true)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{t(status.key, status.fallback)}</p>
          <div className="mt-2">
            {summaryLoading && isGiteaManaged(app) ? (
              <div className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('common.loading', 'Loading…')}
              </div>
            ) : (
              <p
                className="text-[12.5px] text-muted-foreground"
                data-testid="app-control-code-version"
              >
                {(() => {
                  const line = describeCodeVersion(app, summary.gitHead)
                  return t(line.key, line.fallback, line.vars)
                })()}
              </p>
            )}
          </div>
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3.5">
        {settings && (
          <>
            {/* What the app is called, and where its code sits on this machine. */}
            <Group title={t('apps.controlPanel.appGroup', '应用')}>
              <Field label={t('apps.controlPanel.localPath', '本机路径')}>
                {localPathLoading ? (
                  <div className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('common.loading', 'Loading…')}
                  </div>
                ) : !isTauri() ? (
                  <p className="text-[12.5px] text-muted-foreground">
                    {t('apps.controlPanel.localPathDesktopOnly', '本机路径仅在桌面客户端可用。')}
                  </p>
                ) : localWorkdir ? (
                  <div className="space-y-2">
                    {localDeviceName ? (
                      <p className="text-[12px] text-muted-foreground">
                        {t('apps.controlPanel.localPathOnDevice', '设备：{{name}}', {
                          name: localDeviceName,
                        })}
                      </p>
                    ) : null}
                    <details className="text-[12px]">
                      <summary className="cursor-pointer text-ink-2">
                        {localWorkdir.split(/[\\/]/).filter(Boolean).at(-1)}
                      </summary>
                      <p
                        className="mt-2 break-all font-mono text-[11.5px] text-ink-2"
                        data-testid="app-control-local-workdir"
                      >
                        {localWorkdir}
                      </p>
                    </details>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 rounded-[7px] text-[12px]"
                        data-testid="app-control-copy-path"
                        onClick={async () => {
                          try {
                            await copyToClipboard(localWorkdir)
                            toast.success(t('apps.controlPanel.pathCopied', '路径已复制'))
                          } catch (error) {
                            toast.error(String(error))
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {t('common.copy', '复制')}
                      </Button>
                      <details>
                        <summary className="cursor-pointer px-2 py-1.5 text-[12px] text-muted-foreground">
                          {t('apps.controlPanel.moreActions', '更多操作')}
                        </summary>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 rounded-[7px] text-[12px]"
                          onClick={() => {
                            setMoveDest('')
                            setMoveOpen(true)
                          }}
                        >
                          <FolderInput className="h-3.5 w-3.5" />
                          {t('apps.controlPanel.moveDirectory', '移动目录')}
                        </Button>
                      </details>
                    </div>
                  </div>
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">
                    {t(
                      'apps.controlPanel.localPathUnavailable',
                      '本机 daemon 未就绪，或此应用尚未在本机初始化目录。',
                    )}
                  </p>
                )}
              </Field>

              <Field label={t('apps.visibilityLabel', '可见性')}>
                <Select
                  value={app.visibility}
                  onValueChange={(raw) => {
                    const next = raw as AppRow['visibility']
                    if (next === app.visibility) return
                    if (visibilityChangeNeedsConfirm(app.visibility, next)) {
                      setVisibilityPending(next)
                      return
                    }
                    void handleVisibility(next)
                  }}
                  disabled={visibilitySaving}
                >
                  <SelectTrigger
                    className="h-8 rounded-[7px] text-[12.5px]"
                    data-testid="app-control-visibility"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal" className="text-[12.5px]">
                      {t('apps.visibilityPersonal', '仅自己和被授权的人')}
                    </SelectItem>
                    <SelectItem value="team" className="text-[12.5px]">
                      {t('apps.visibilityTeam', '全团队可见')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11.5px] text-faint">
                  {app.visibility === 'team'
                    ? t('apps.visibilityTeamHint', '团队里每个人都能在应用列表里看到它。')
                    : t(
                        'apps.visibilityPersonalHint',
                        '只有你、以及在「协作权限」里被授权的成员看得到。本机 daemon 也看不到它。',
                      )}
                </p>
              </Field>

              <Field label={t('apps.typeLabel', '类型')}>
                <Select
                  value={appType.id}
                  onValueChange={(raw) => {
                    const next = resolveAppType(raw).id
                    if (next === appType.id) return
                    if (typeChangeNeedsConfirm(appType.id, next)) {
                      setTypeTarget(next)
                      setTypeConfirmOpen(true)
                      return
                    }
                    void handleType(next)
                  }}
                  disabled={typeSaving}
                >
                  <SelectTrigger
                    className="h-8 rounded-[7px] text-[12.5px]"
                    data-testid="app-control-type"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SELECTABLE_APP_TYPES.map((meta) => (
                      <SelectItem key={meta.id} value={meta.id} className="text-[12.5px]">
                        {t(meta.labelKey, meta.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11.5px] text-faint" data-testid="app-control-type-hint">
                  {t(appType.descriptionKey, appType.description)}
                </p>
                {/* `=== true`: a server older than the flag omits it, and an
                absent flag is "nothing pending", not "maybe". */}
                {app.typePendingRedeploy === true && (
                  <p
                    className="mt-1 text-[11.5px] text-muted-foreground"
                    data-testid="app-control-type-pending"
                  >
                    {t(
                      'apps.typePendingRedeploy',
                      '线上还是按原来的类型在跑，下次部署后才换过来。',
                    )}
                  </p>
                )}
              </Field>

              {showReseed && (
                <Field label={t('apps.reseed', '重新播种')}>
                  <p className="mb-2 text-[12px] text-muted-foreground">
                    {t(
                      'apps.controlPanel.reseedHint',
                      '重新写入模板或克隆仓库。仅在初始化失败或目录为空时使用。',
                    )}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-[7px] text-[12px]"
                    disabled={reseeding}
                    onClick={() => void handleReseed()}
                  >
                    {reseeding ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {t('apps.reseed', 'Reseed')}
                  </Button>
                </Field>
              )}
            </Group>
          </>
        )}
        {!settings && (
          <>
            <Group title={t('apps.controlPanel.runtimeGroup', '运行与数据')}>
              <SummaryRow
                label={t('apps.data.section', '线上数据')}
                value={tablesValue}
                loading={summaryLoading}
                testId="app-control-open-data"
                disabled={!summary.tables || 'reason' in summary.tables || !summary.tables.first}
                onOpen={openData}
              />
              <SummaryRow
                label={t('apps.logs.section', '运行日志')}
                value={logsValue}
                testId="app-control-open-logs"
                disabled={!deployed}
                onOpen={() => {
                  if (!deployed) {
                    toast.info(
                      t('apps.logs.notDeployed', '这个应用还没有部署过，部署之后才会有日志。'),
                    )
                    return
                  }
                  openAppLogs(app, t('apps.logs.tabLabel', '日志'))
                }}
              />
              <SummaryRow
                label={t('apps.files.tabTitle', '应用附件')}
                value={filesValue}
                loading={summaryLoading}
                testId="app-control-open-files"
                onOpen={() => openAppFiles(app, t('apps.files.tabTitle', '应用附件'))}
              />
              <SummaryRow
                label={t('apps.cron.tabTitle', '定时任务')}
                value={cronValue}
                loading={summaryLoading}
                testId="app-control-open-cron"
                onOpen={() => openAppCron(app, t('apps.cron.tabTitle', '定时任务'))}
              />
            </Group>
            <Group title={t('apps.controlPanel.configGroup', '访问与配置')}>
              <SummaryRow
                label={t('apps.access.tabTitle', '协作权限')}
                description={t('apps.controlPanel.accessHint', '谁能管理应用')}
                value={membersValue}
                loading={summaryLoading}
                testId="app-control-open-access"
                onOpen={() => openAppAccess(app, t('apps.access.tabTitle', '协作权限'))}
              />
              <SummaryRow
                label={t('apps.auth.tabTitle', '应用权限')}
                description={t('apps.controlPanel.authHint', '谁能访问线上页面')}
                value={rulesValue}
                testId="app-control-open-auth"
                onOpen={() => openAppAuth(app, t('apps.auth.tabTitle', '应用权限'))}
              />
              <SummaryRow
                label={t('apps.env.tabTitle', '变量与密钥')}
                value={envValue}
                loading={summaryLoading}
                testId="app-control-open-env"
                onOpen={() => openAppEnv(app, t('apps.env.tabTitle', '变量与密钥'))}
              />
            </Group>
            <div className="mt-5 border-t border-border-soft pt-3">
              <SummaryRow
                label={t('apps.controlPanel.settings', '应用设置')}
                value={null}
                testId="app-control-open-settings"
                onOpen={() => openAppSettings(app, t('apps.controlPanel.settings', '应用设置'))}
              />
            </div>
          </>
        )}
        {settings && (
          <>
            {/* The address the deployed site answers on. Unchanged. */}
            <Group title={t('apps.controlPanel.liveGroup', '线上')}>
              <Field label={t('apps.controlPanel.customDomain', '自定义域名')}>
                <AppCustomDomainSection app={app} />
              </Field>
            </Group>

            {/* Last, and on its own: the only irreversible control in the panel. */}
            <Group title={t('apps.delete', '删除')}>
              <p className="mb-2 text-[12px] text-muted-foreground">
                {t(
                  'apps.controlPanel.deleteHint',
                  '删除后线上站点会立刻下线；应用数据库和已上传的文件都会保留。代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。',
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-[7px] border-destructive/30 text-destructive text-[12px]"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('apps.delete', 'Delete')}
              </Button>
            </Group>
          </>
        )}
      </div>

      <AlertDialog
        open={moveOpen}
        onOpenChange={(open) => {
          if (!moving) setMoveOpen(open)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('apps.controlPanel.moveDirectory', '移动目录')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.controlPanel.moveDirectoryHint',
                '将整棵应用目录（含 .git 与 node_modules）迁移到新路径。失败时会保留原目录。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="font-mono text-[11px] text-faint break-all">{localWorkdir}</p>
            <div className="flex gap-1.5">
              <Input
                value={moveDest}
                onChange={(e) => setMoveDest(e.target.value)}
                placeholder={t('apps.controlPanel.moveDirectoryDest', '新目录路径')}
                className="h-8 flex-1 rounded-[7px] font-mono text-[12px]"
                disabled={moving}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-[7px] text-[12px]"
                disabled={moving}
                onClick={() => void handleMovePickFolder()}
              >
                {t('apps.controlPanel.moveDirectoryBrowse', '浏览…')}
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={moving}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={moving || !moveDest.trim()}
              onClick={() => void handleMoveConfirm()}
            >
              {moving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.controlPanel.moveDirectoryConfirm', '移动')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={visibilityPending !== null}
        onOpenChange={(open) => {
          if (!open && !visibilitySaving) setVisibilityPending(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('apps.visibilityNarrowTitle', '改成只有你和被授权的人可见？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.visibilityNarrowConfirm',
                '团队里其他人会在应用列表里看不到它。在「协作权限」里授权过的成员不受影响 —— 他们仍然看得到。本机 daemon 拿不到授权，所以它会看不到这个应用。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={visibilitySaving}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={visibilitySaving}
              onClick={(e) => {
                e.preventDefault()
                void handleVisibility('personal')
              }}
              data-testid="app-control-visibility-confirm"
            >
              {visibilitySaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.visibilityNarrowAction', '改成仅授权可见')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={typeConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !typeSaving) setTypeConfirmOpen(false)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('apps.typeLeaveDatabaseTitle', '改成不带数据库的类型？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/* Three things, because each is the one people get wrong: it is
                  not immediate, it does break on the next deploy, and nothing
                  is deleted. */}
              {t(
                'apps.typeLeaveDatabaseConfirm',
                '线上站点在下次部署前照常运行。下次部署后，应用不再拿到 DATABASE_URL，代码里用到数据库的地方会出错。数据不会删除：「线上数据」里暂时看不到它，改回「{{dataApp}}」就回来。',
                { dataApp: t(DATA_APP_TYPE.labelKey, DATA_APP_TYPE.label) },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={typeSaving}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={typeSaving}
              onClick={(e) => {
                e.preventDefault()
                if (typeTarget) void handleType(typeTarget)
              }}
              data-testid="app-control-type-confirm"
            >
              {typeSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.typeLeaveDatabaseAction', '改成「{{type}}」', {
                  type: typeTargetMeta ? t(typeTargetMeta.labelKey, typeTargetMeta.label) : '',
                })
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('apps.controlPanel.deleteTitle', '删除应用？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.controlPanel.deleteConfirm',
                '线上站点会立刻下线，应用数据库会保留。代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('apps.delete', 'Delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
