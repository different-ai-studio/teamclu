import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink, FolderInput, Loader2, RefreshCw, Trash2 } from 'lucide-react'
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
import { cn, copyToClipboard, isTauri, openExternalUrl } from '@/lib/utils'
import { appGitKind, appStatusMeta, canReseed } from '@/lib/apps/app-list-helpers'
import { APP_TYPES, IMPORTED_APP_TYPE, resolveAppType, type AppTypeId } from '@/lib/apps/app-types'
import { forgetAppSessionSetups } from '@/lib/apps/app-session-setup'
import { daemonAppWorkdir, moveDaemonAppWorkdir } from '@/lib/daemon/daemon-local-client'
import { openAppAuth } from '@/lib/tabs/app-tabs'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { useAppsStore } from '@/stores/apps-store'
import { AppCustomDomainSection } from './AppCustomDomainSection'
import { AppStatusDot } from './AppStatusDot'
import type { AppRow } from '@/lib/backend/types'

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

/** What the repo's kind means for deploys and downloads, per `appGitKind`. */
const REPO_HINTS = {
  hosted: {
    key: 'apps.settingsPage.repoHostedHint',
    fallback: '托管仓库 —— 部署时从这个仓库取代码。',
  },
  remote: {
    key: 'apps.settingsPage.repoRemoteHint',
    fallback: '外部仓库 —— 这里没有它的凭证，部署用的是本机目录里的代码。',
  },
  local: {
    key: 'apps.settingsPage.repoLocalHint',
    fallback: '仅本机 —— 代码只在创建它的那台机器上，其他设备下载不到。',
  },
} as const

const AUTH_MODE_FALLBACKS: Record<AppRow['authMode'], string> = {
  none: '无需登录（公开）',
  platform: 'TeamClu 账号登录',
  third: '第三方登录（暂不支持）',
}

const ACCESS_FALLBACKS = {
  public: '不需要登录',
  any: '需要登录 · 任何用户',
  org: '需要登录 · 仅员工',
} as const

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * One titled group of settings on a paper card.
 *
 * The settings tab is a wide page, not the 280px side panel these controls used
 * to share, so every row gets a label column and a value column. The container
 * query — not a viewport one — is what stacks them again when the tab is
 * narrow: the tab's width moves with the side panels while the window's does
 * not.
 */
function Section({
  title,
  danger = false,
  children,
}: {
  title: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="@container">
      <h2 className="mb-2 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        {title}
      </h2>
      <div
        className={cn(
          'divide-y divide-border-soft rounded-[12px] border bg-paper',
          danger ? 'border-destructive/25' : 'border-border-soft',
        )}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * A label and its value. Baseline-aligned, so a label lines up with the first
 * line of whatever sits beside it — a text value, a select, or a URL that wraps
 * onto three lines.
 */
function Row({
  label,
  hint,
  testId,
  children,
}: {
  label: string
  hint?: React.ReactNode
  testId?: string
  children: React.ReactNode
}) {
  return (
    <div
      className="grid gap-x-6 gap-y-1.5 px-4 py-3 @[560px]:grid-cols-[152px_minmax(0,1fr)] @[560px]:items-baseline"
      data-testid={testId}
    >
      <div className="text-[12.5px] font-medium text-ink-2">{label}</div>
      <div className="min-w-0">
        {children}
        {hint ? <div className="mt-1.5 text-[11.5px] leading-relaxed text-faint">{hint}</div> : null}
      </div>
    </div>
  )
}

/** A value that is not there, said in words rather than left blank. */
function Absent({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}

/**
 * A value people paste somewhere else — a repo URL, an id, a path.
 *
 * Wraps instead of truncating: a truncated SHA or URL is a wrong one, and the
 * page has the room.
 */
function CopyableValue({
  value,
  href,
  testId,
  copyTestId,
}: {
  value: string
  /** Offered as "open" only for http(s); an ssh remote has nowhere to go. */
  href?: string | null
  testId?: string
  copyTestId?: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  const openable = href && /^https?:\/\//i.test(href) ? href : null

  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <span
        className="min-w-0 flex-1 break-all py-[3px] font-mono text-[12px] leading-[18px] text-foreground"
        data-testid={testId}
      >
        {value}
      </span>
      {openable && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-[6px] text-muted-foreground"
          aria-label={t('apps.settingsPage.open', '打开')}
          data-testid={testId ? `${testId}-open` : undefined}
          onClick={() => void openExternalUrl(openable)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 rounded-[6px] text-muted-foreground"
        aria-label={t('common.copy', '复制')}
        data-testid={copyTestId ?? (testId ? `${testId}-copy` : undefined)}
        onClick={async () => {
          await copyToClipboard(value)
          setCopied(true)
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

interface KeyValueItem {
  key: string
  label: string
  value: string | null
  copy?: boolean
}

/** Several small facts under one row label — ids, a start command, a region. */
function KeyValues({ items, testId }: { items: KeyValueItem[]; testId?: string }) {
  return (
    <dl
      className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-0.5"
      data-testid={testId}
    >
      {items.map((item) => (
        <React.Fragment key={item.key}>
          <dt className="text-[12px] leading-[24px] text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0">
            {item.value === null ? (
              <span className="text-[12px] leading-[24px] text-faint">—</span>
            ) : item.copy ? (
              <CopyableValue value={item.value} />
            ) : (
              <span className="block break-all py-[3px] font-mono text-[12px] leading-[18px] text-foreground">
                {item.value}
              </span>
            )}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/**
 * Everything an app IS, on one page: what it is called and who made it, where
 * its code lives, how and where it is deployed, and who can reach it.
 *
 * The side panel answers "how much is there" and links out; this is the page
 * for "what exactly is this app", so every field on the row is shown — the
 * ones people paste elsewhere (repo URL, commit, ids, addresses) with copy
 * beside them. Editing the login wall stays in its own tab; this page says what
 * the wall currently is and links there.
 */
export function AppSettingsPanel({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const reseed = useAppsStore((s) => s.reseed)
  const setVisibility = useAppsStore((s) => s.setVisibility)
  const setType = useAppsStore((s) => s.setType)
  const rename = useAppsStore((s) => s.rename)
  const deleteApp = useAppsStore((s) => s.deleteApp)
  const { actors } = useActorDirectory()

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

  // Resolved, not raw: a legacy stored type has to land on 数据操作 in the
  // Select, or the trigger would render blank for every pre-split app.
  const appType = resolveAppType(app.type)
  const typeTargetMeta = typeTarget ? resolveAppType(typeTarget) : null

  React.useEffect(() => {
    setNameDraft(app.name)
  }, [app.id, app.name])

  const status = appStatusMeta(app, deploying)
  const showReseed = canReseed(app.provisionStatus)
  const gitKind = appGitKind(app)
  const repoHint = REPO_HINTS[gitKind.kind]
  const deployed = Boolean(app.fcStatus) && app.fcStatus !== 'not_deployed'
  const address = app.publicUrl ?? app.fcEndpoint
  const creator = app.createdByActorId
    ? (actors.find((actor) => actor.id === app.createdByActorId)?.display_name ?? null)
    : null
  const createdAt = formatWhen(app.createdAt)
  const updatedAt = formatWhen(app.updatedAt)
  const nameDirty = nameDraft.trim() !== app.name

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
      console.error('[AppSettingsPanel] failed to load local path', e)
      setLocalWorkdir(null)
      setLocalDeviceName(null)
    } finally {
      setLocalPathLoading(false)
    }
  }, [app.id, app.teamId])

  React.useEffect(() => {
    void loadLocalPath()
  }, [loadLocalPath])

  const handleRename = async () => {
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === app.name) return
    setRenaming(true)
    try {
      await rename(app.id, trimmed)
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
        // Every session opened so far is bound to the old directory. Forgetting
        // their setup makes the next switch to each one bind it again.
        forgetAppSessionSetups(app.id)
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

  // The store recounts the side panel's summary on success — the data row's
  // answer depends on the type — so there is nothing to refresh here.
  const handleType = async (next: AppTypeId) => {
    setTypeSaving(true)
    try {
      const ok = await setType(app.id, next)
      if (ok) setTypeConfirmOpen(false)
    } finally {
      setTypeSaving(false)
    }
  }

  // --- what the deployed-commit row says ---------------------------------------

  const commitRow = (() => {
    if (app.gitCommitSha) {
      return {
        value: <CopyableValue value={app.gitCommitSha} testId="app-settings-commit" />,
        // `git_commit_sha` is stamped when a deploy STARTS, so on anything but a
        // live app it names the commit the last deploy attempted, not what serves.
        hint:
          app.fcStatus !== 'live'
            ? t(
                'apps.settingsPage.commitNotLive',
                '这是上次尝试部署的提交，那次没有成功上线。',
              )
            : undefined,
      }
    }
    // An imported app deploys its folder as it sits; there is no commit to name.
    if (deployed && gitKind.kind !== 'hosted') {
      return {
        value: (
          <Absent>
            {t('apps.settingsPage.commitLocalFolder', '部署的是本机目录，不对应某个提交')}
          </Absent>
        ),
        hint: undefined,
      }
    }
    return {
      value: <Absent>{t('apps.settingsPage.commitNever', '还没有部署过')}</Absent>,
      hint: undefined,
    }
  })()

  // --- the start declaration, as far as the last successful deploy left it -----

  const startItems: KeyValueItem[] = app.startSpec
    ? [
        {
          key: 'build',
          label: t('apps.settingsPage.buildKind', '构建方式'),
          value: app.runtime,
        },
        {
          key: 'port',
          label: t('apps.settingsPage.startPort', '端口'),
          value: app.startSpec.port != null ? String(app.startSpec.port) : null,
        },
        {
          key: 'command',
          label: t('apps.settingsPage.startCommand', '启动命令'),
          value:
            [...(app.startSpec.command ?? []), ...(app.startSpec.args ?? [])].join(' ') || null,
        },
        {
          key: 'runtime',
          label: t('apps.settingsPage.startRuntime', '运行时'),
          value: app.startSpec.fcRuntime ?? null,
        },
        {
          key: 'health',
          label: t('apps.settingsPage.startHealthCheck', '健康检查'),
          value: app.startSpec.healthCheckPath ?? null,
        },
        {
          key: 'layers',
          label: t('apps.settingsPage.startLayers', '层'),
          value: app.startSpec.layers?.length ? app.startSpec.layers.join(', ') : null,
        },
        // A field the declaration left out is not worth a row of dashes.
      ].filter((item) => item.value !== null)
    : []

  // --- the login wall, summarised --------------------------------------------

  // Strict defaults, as the auth tab reads them: an older server omits these,
  // and an unknown server must never make an app look more open than it is.
  const authRules = app.authRules ?? []
  const baselineAccess = (app.authScope ?? 'all') === 'paths' ? 'public' : (app.authAudience ?? 'org')
  const baselineAccessLabel = t(`apps.auth.access.${baselineAccess}`, ACCESS_FALLBACKS[baselineAccess])

  return (
    <div className="space-y-7 pb-8" data-testid="app-settings">
      <Section title={t('apps.settingsPage.generalGroup', '基本信息')}>
        <Row label={t('apps.nameLabel', '名称')}>
          <form
            className="flex max-w-[420px] items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void handleRename()
            }}
          >
            <Input
              aria-label={t('apps.nameLabel', '名称')}
              value={nameDraft}
              disabled={renaming}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !renaming) setNameDraft(app.name)
              }}
              className="h-9 min-w-0 flex-1 rounded-[7px] text-[13px]"
              data-testid="app-settings-name"
            />
            {nameDirty && (
              <Button
                type="submit"
                size="sm"
                className="h-9 shrink-0 rounded-[7px] px-3 text-[12.5px]"
                disabled={renaming || !nameDraft.trim()}
                data-testid="app-settings-name-save"
              >
                {renaming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('common.save', '保存')
                )}
              </Button>
            )}
          </form>
        </Row>

        <Row
          label={t('apps.typeLabel', '类型')}
          hint={
            <>
              <span data-testid="app-control-type-hint">
                {t(appType.descriptionKey, appType.description)}
              </span>
              {/* `=== true`: a server older than the flag omits it, and an
                  absent flag is "nothing pending", not "maybe". */}
              {app.typePendingRedeploy === true && (
                <span
                  className="mt-0.5 block text-muted-foreground"
                  data-testid="app-control-type-pending"
                >
                  {t('apps.typePendingRedeploy', '线上还是按原来的类型在跑，下次部署后才换过来。')}
                </span>
              )}
            </>
          }
        >
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
              className="h-9 w-full max-w-[280px] rounded-[7px] text-[13px]"
              data-testid="app-control-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTABLE_APP_TYPES.map((meta) => (
                <SelectItem key={meta.id} value={meta.id} className="text-[13px]">
                  {t(meta.labelKey, meta.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row
          label={t('apps.visibilityLabel', '可见性')}
          hint={
            app.visibility === 'team'
              ? t('apps.visibilityTeamHint', '团队里每个人都能在应用列表里看到它。')
              : t(
                  'apps.visibilityPersonalHint',
                  '只有你、以及在「协作权限」里被授权的成员看得到。本机 daemon 也看不到它。',
                )
          }
        >
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
              className="h-9 w-full max-w-[280px] rounded-[7px] text-[13px]"
              data-testid="app-control-visibility"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal" className="text-[13px]">
                {t('apps.visibilityPersonal', '仅自己和被授权的人')}
              </SelectItem>
              <SelectItem value="team" className="text-[13px]">
                {t('apps.visibilityTeam', '全团队可见')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row label={t('apps.settingsPage.created', '创建')}>
          <p className="text-[13px] text-foreground" data-testid="app-settings-created">
            {creator ?? t('apps.settingsPage.creatorUnknown', '未知成员')}
            {createdAt && (
              <span className="ml-2 tabular-nums text-[12px] text-faint">{createdAt}</span>
            )}
          </p>
        </Row>

        <Row label={t('apps.settingsPage.updated', '最近更新')}>
          <p className="tabular-nums text-[13px] text-foreground">{updatedAt ?? '—'}</p>
        </Row>

        <Row label={t('apps.settingsPage.identifiers', '标识')}>
          <KeyValues
            testId="app-settings-identifiers"
            items={[
              {
                key: 'id',
                label: t('apps.settingsPage.appId', '应用 ID'),
                value: app.id,
                copy: true,
              },
              {
                key: 'slug',
                label: t('apps.settingsPage.slug', 'Slug'),
                value: app.slug,
                copy: true,
              },
              {
                key: 'workspace',
                label: t('apps.settingsPage.workspaceId', '工作区 ID'),
                value: app.workspaceId,
                copy: true,
              },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('apps.settingsPage.codeGroup', '代码')}>
        <Row label={t('apps.settingsPage.repo', '仓库')} hint={t(repoHint.key, repoHint.fallback)}>
          {app.gitRemoteUrl ? (
            <CopyableValue
              value={app.gitRemoteUrl}
              href={app.gitRemoteUrl}
              testId="app-settings-git-remote"
            />
          ) : (
            <Absent>{t('apps.settingsPage.repoNone', '没有远端仓库')}</Absent>
          )}
        </Row>

        <Row label={t('apps.settingsPage.commit', '部署的提交')} hint={commitRow.hint}>
          {commitRow.value}
        </Row>

        <Row label={t('apps.controlPanel.localPath', '本机路径')}>
          {localPathLoading ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', 'Loading…')}
            </p>
          ) : !isTauri() ? (
            <Absent>
              {t('apps.controlPanel.localPathDesktopOnly', '本机路径仅在桌面客户端可用。')}
            </Absent>
          ) : localWorkdir ? (
            <div className="space-y-2">
              <CopyableValue
                value={localWorkdir}
                testId="app-control-local-workdir"
                copyTestId="app-control-copy-path"
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {localDeviceName ? (
                  <span className="text-[11.5px] text-faint">
                    {t('apps.controlPanel.localPathOnDevice', '设备：{{name}}', {
                      name: localDeviceName,
                    })}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-[7px] text-[12px]"
                  onClick={() => {
                    setMoveDest('')
                    setMoveOpen(true)
                  }}
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  {t('apps.controlPanel.moveDirectory', '移动目录')}
                </Button>
              </div>
            </div>
          ) : (
            <Absent>
              {t(
                'apps.controlPanel.localPathUnavailable',
                '本机 daemon 未就绪，或此应用尚未在本机初始化目录。',
              )}
            </Absent>
          )}
        </Row>

        {showReseed && (
          <Row
            label={t('apps.reseed', '重新播种')}
            hint={t(
              'apps.controlPanel.reseedHint',
              '重新写入模板或克隆仓库。仅在初始化失败或目录为空时使用。',
            )}
          >
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
          </Row>
        )}
      </Section>

      <Section title={t('apps.settingsPage.deployGroup', '部署')}>
        <Row label={t('apps.settingsPage.status', '状态')}>
          <p className="text-[13px] text-foreground" data-testid="app-settings-status">
            <AppStatusDot tone={status.dot} className="mr-2 align-middle" />
            {t(status.key, status.fallback)}
          </p>
          {/* Both flags are "the settings changed but the running function has
              not" — the one thing a status line that says 已上线 would hide. */}
          {app.envPendingRedeploy === true && (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {t(
                'apps.env.pendingRedeploy',
                '这些变量还没有生效 —— 它们是在部署时写进应用的，改完要重新部署一次。',
              )}
            </p>
          )}
          {app.authModePendingRedeploy === true && (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {t(
                'apps.controlPanel.authEnvPending',
                '登录设置已生效。但应用代码要读取登录用户信息，还需要重新部署一次 —— 相关配置是在部署时写进应用的。',
              )}
            </p>
          )}
        </Row>

        <Row label={t('apps.settingsPage.address', '访问地址')}>
          {address ? (
            <CopyableValue value={address} href={address} testId="app-settings-address" />
          ) : (
            <Absent>{t('apps.controlPanel.summaryNotDeployed', '未部署')}</Absent>
          )}
        </Row>

        {/* Only when there is a vanity address in front of it; otherwise the
            endpoint IS the address above, and a second row would repeat it. */}
        {app.publicUrl && app.fcEndpoint && app.fcEndpoint !== app.publicUrl && (
          <Row
            label={t('apps.settingsPage.endpoint', '函数地址')}
            hint={t('apps.settingsPage.endpointHint', '平台分配的原始地址，访问地址背后就是它。')}
          >
            <CopyableValue
              value={app.fcEndpoint}
              href={app.fcEndpoint}
              testId="app-settings-endpoint"
            />
          </Row>
        )}

        <Row label={t('apps.settingsPage.function', '函数')}>
          {app.fcFunctionName || app.fcRegion ? (
            <KeyValues
              testId="app-settings-function"
              items={[
                {
                  key: 'name',
                  label: t('apps.settingsPage.functionName', '名称'),
                  value: app.fcFunctionName,
                  copy: true,
                },
                {
                  key: 'region',
                  label: t('apps.settingsPage.functionRegion', '地域'),
                  value: app.fcRegion,
                },
              ]}
            />
          ) : (
            <Absent>{t('apps.controlPanel.summaryNotDeployed', '未部署')}</Absent>
          )}
        </Row>

        <Row
          label={t('apps.settingsPage.start', '构建与启动')}
          hint={
            app.startSpec ? t('apps.settingsPage.startHint', '取自最近一次成功的部署。') : undefined
          }
        >
          {app.startSpec ? (
            <KeyValues testId="app-settings-start" items={startItems} />
          ) : (
            <Absent>{t('apps.settingsPage.startNone', '还没有成功部署过')}</Absent>
          )}
        </Row>

        <Row label={t('apps.controlPanel.customDomain', '自定义域名')}>
          <AppCustomDomainSection app={app} />
        </Row>
      </Section>

      <Section title={t('apps.settingsPage.accessGroup', '线上访问')}>
        <Row label={t('apps.controlPanel.authMode', '登录方式')}>
          <div data-testid="app-settings-auth">
            <p className="text-[13px] text-foreground">
              {t(`apps.controlPanel.authModeOption.${app.authMode}`, AUTH_MODE_FALLBACKS[app.authMode])}
            </p>
            {app.authMode === 'platform' && (
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {authRules.length === 0
                  ? t('apps.settingsPage.authSiteWide', '全站：{{access}}', {
                      access: baselineAccessLabel,
                    })
                  : `${t('apps.settingsPage.authOtherPages', '其余页面：{{access}}', {
                      access: baselineAccessLabel,
                    })} · ${t('apps.controlPanel.summaryRules', '{{count}} 条页面规则', {
                      count: authRules.length,
                    })}`}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-7 rounded-[7px] text-[12px]"
            data-testid="app-settings-open-auth"
            onClick={() => openAppAuth(app, t('apps.auth.tabTitle', '应用权限'))}
          >
            {t('apps.settingsPage.authEdit', '修改应用权限')}
          </Button>
        </Row>

        {app.oauthClientId && (
          <Row label={t('apps.settingsPage.oauthClientId', 'OAuth Client ID')}>
            <CopyableValue value={app.oauthClientId} testId="app-settings-oauth-client" />
          </Row>
        )}
      </Section>

      {/* Last, and on its own: the only irreversible control on the page. */}
      <Section title={t('apps.settingsPage.dangerGroup', '危险操作')} danger>
        <Row label={t('apps.delete', '删除')}>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t(
              'apps.controlPanel.deleteHint',
              '删除后线上站点会立刻下线；应用数据库和已上传的文件都会保留。代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2.5 h-8 gap-1.5 rounded-[7px] border-destructive/30 text-[12px] text-destructive hover:bg-destructive/5 hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('apps.delete', 'Delete')}
          </Button>
        </Row>
      </Section>

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
