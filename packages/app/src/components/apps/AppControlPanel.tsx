import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Loader2, Save, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import {
  APP_AUTH_ACCESS_FALLBACKS,
  summarizeAppAuthBaseline,
} from '@/lib/apps/app-auth-access'
import { appStatusMeta } from '@/lib/apps/app-list-helpers'
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
import { AppStatusDot } from './AppStatusDot'
import type { AppGitHead, AppRow } from '@/lib/backend/types'

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
function useAppSummary(app: AppRow): { summary: Summary; loading: boolean } {
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
  }, [app.id, revision, managed])

  return { summary, loading }
}

interface AppControlPanelProps {
  app: AppRow
}

/**
 * The narrow side panel: the app's name and state, how much of each surface
 * there is, and a way into each. Everything the app IS — repo, deploy target,
 * identifiers, visibility, type, deletion — lives on the settings tab
 * (`AppSettingsPanel`), which has the width to show it.
 */
export function AppControlPanel({ app }: AppControlPanelProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const rename = useAppsStore((s) => s.rename)

  const [editingName, setEditingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(app.name)
  const [renaming, setRenaming] = React.useState(false)

  const { summary, loading: summaryLoading } = useAppSummary(app)

  React.useEffect(() => {
    setNameDraft(app.name)
  }, [app.id, app.name])

  const status = appStatusMeta(app, deploying)

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
    const summary = summarizeAppAuthBaseline(app)
    const baseline = !summary.requiresLogin
      ? t('apps.auth.access.public', APP_AUTH_ACCESS_FALLBACKS.public)
      : summary.roleCodes === null
        ? t('apps.auth.access.org', APP_AUTH_ACCESS_FALLBACKS.orgLegacy)
        : summary.roleCodes.length === 0
          ? t('apps.auth.access.any', APP_AUTH_ACCESS_FALLBACKS.any)
          : t('apps.auth.access.roles', '需要登录 · {{roles}}', {
              roles: summary.roleCodes.join(', '),
            })
    // A `/` rule encodes the baseline under the new model — don't count it as
    // an exception when summarising the side panel.
    const exceptions = (app.authRules ?? []).filter((r) => !(r.path === '/' && r.auth === 'required'))
    const count = exceptions.length
    return count === 0
      ? baseline
      : `${baseline} · ${t('apps.controlPanel.summaryRules', '{{count}} 条页面规则', { count })}`
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
      <header className="shrink-0 border-b border-border-soft px-3.5 py-3">
        <div className="flex items-center gap-2">
          <AppStatusDot tone={status.dot} />
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

      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3.5">
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
      </div>
    </div>
  )
}
