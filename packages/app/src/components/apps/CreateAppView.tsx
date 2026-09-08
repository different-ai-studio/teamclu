import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronRight, FolderOpen, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { APP_TYPES, DEFAULT_APP_TYPE, IMPORTED_APP_TYPE, type AppTypeId } from '@/lib/apps/app-types'
import { appTypeIcon } from '@/lib/apps/app-type-icon'
import { closeCreateApp } from '@/lib/tabs/app-tabs'
import { bindDaemonAppWorkdir, inspectDaemonDir } from '@/lib/daemon/daemon-local-client'
import { isTauri } from '@/lib/utils'

type Visibility = 'personal' | 'team'

/**
 * Where a new app's code comes from. The three the product supports, and the
 * only three: a repo we provision, a repo someone else already has, or a
 * checkout already sitting on this machine.
 */
type AppSource = 'new' | 'local' | 'remote'

/**
 * Whether a repo URL is one `git clone` will treat as an address.
 *
 * Mirrors the same allowlist the cloud API and the daemon apply — http(s) /
 * ssh / git://, or scp-like `git@host:path`. Checked here so a typo is a red
 * line under the field instead of a 400 after the app row already exists.
 */
export function isValidGitRemoteUrl(raw: string): boolean {
  const url = raw.trim()
  if (!url) return true // empty means "no import", which is the default
  return /^(https?|ssh|git):\/\/[^\s]+$/.test(url) || /^[^\s:/@]+@[^\s:/@]+:[^\s]+$/.test(url)
}

interface AppSourceMeta {
  id: AppSource
  labelKey: string
  label: string
  descriptionKey: string
  description: string
}

/** Order matters: the default — we make the repo — reads first. */
const SOURCES: AppSourceMeta[] = [
  {
    id: 'new',
    labelKey: 'apps.sourceNew',
    label: '新建一个',
    descriptionKey: 'apps.sourceNewDesc',
    description: '从模板起一个新目录，代码托管在我们这里。',
  },
  {
    id: 'local',
    labelKey: 'apps.sourceLocal',
    label: '用本机已有的目录',
    descriptionKey: 'apps.sourceLocalDesc',
    description: '选一个已经是 git 仓库的目录，留在原地。',
  },
  {
    id: 'remote',
    labelKey: 'apps.sourceRemote',
    label: '从 git 地址克隆',
    descriptionKey: 'apps.sourceRemoteDesc',
    description: '把一个已有的仓库克隆下来当作应用的代码。',
  },
]

/** Shared chrome for the two radio-card grids — source, and type. */
const CARD = 'flex flex-col gap-0.5 rounded-[9px] border px-3 py-2.5 text-left transition-colors disabled:opacity-50'
const CARD_ON = 'border-coral bg-coral/5'
const CARD_OFF = 'border-border-soft bg-paper hover:bg-selected/30'

/**
 * The create form, in the main column.
 *
 * It was a modal. Picking a local directory opens a native file dialog on top
 * of it, and what it covered was column two — the list the new app is about to
 * appear in. As a tab it can be left open while the user goes to look at
 * something, which is the actual shape of the task.
 */
export function CreateAppView() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const [name, setName] = React.useState('')
  const [source, setSource] = React.useState<AppSource>('new')
  const [appType, setAppType] = React.useState<AppTypeId>(DEFAULT_APP_TYPE)
  const [visibility, setVisibility] = React.useState<Visibility>('personal')
  const [gitRemoteUrl, setGitRemoteUrl] = React.useState('')
  const [localDir, setLocalDir] = React.useState('')
  const [localOrigin, setLocalOrigin] = React.useState<string | null>(null)
  const [localIsRepo, setLocalIsRepo] = React.useState(false)
  const [picking, setPicking] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // No reset effect: closing the tab unmounts this, and reopening it mounts a
  // fresh one. What the dialog needed a `!open` branch for, the tab gets free.

  const trimmed = name.trim()
  const trimmedRepo = gitRemoteUrl.trim()
  const repoValid = isValidGitRemoteUrl(gitRemoteUrl)
  const sourceReady =
    source === 'new' ||
    (source === 'remote' && !!trimmedRepo && repoValid) ||
    (source === 'local' && !!localDir)
  const canSubmit = !!trimmed && !!teamId && sourceReady && !submitting

  /**
   * Pick a directory and check it before anything is created.
   *
   * The check has to happen here rather than at bind time: by then the app row
   * exists, so a wrong folder would leave an app pointing nowhere with no
   * obvious way to tell that is what happened.
   */
  const pickLocalDir = async () => {
    if (!isTauri()) return
    setPicking(true)
    setError(null)
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('apps.sourceLocalPick', '选择一个 git 目录'),
      })
      if (typeof selected !== 'string' || !selected) return
      const probe = await inspectDaemonDir(selected)
      if (!probe) {
        setError(t('apps.sourceLocalDaemonOffline', '本机 amuxd 未连接，无法检查这个目录。'))
        return
      }
      // Not a git repo is no longer a refusal. A folder someone points at is
      // as often "the thing I have been working on" as it is a checkout, and
      // the app can host it: see `adoptLocalDir`.
      setLocalDir(selected)
      setLocalIsRepo(probe.isGitRepo)
      setLocalOrigin(probe.isGitRepo ? probe.gitRemoteUrl : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPicking(false)
    }
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      // Imports carry no template and no type choice — `imported` is what keeps
      // them out of `needsDatabase`, which treats every unknown type as a data
      // app and would demand a Postgres schema on their first deploy.
      const importing = source !== 'new'
      // A picked folder with a remote of its own is recorded and left alone.
      // Without one — not a repo, or a repo nobody pushed — there is nothing to
      // record, so the app gets a Gitea repo and the folder is published into
      // it. Either way no template is written over the user's files.
      const adopting = source === 'local' && !localOrigin
      const app = await useAppsStore.getState().create({
        teamId,
        name: trimmed,
        type: importing ? IMPORTED_APP_TYPE.id : appType,
        visibility,
        // Both import paths record where the code came from. For a local
        // checkout that is its own `origin`.
        gitRemoteUrl: source === 'remote' ? trimmedRepo : source === 'local' ? localOrigin : null,
        // Provision nothing only when there is already a remote to deploy from.
        localOnly: source === 'local' && !adopting,
        adoptLocalDir: adopting ? localDir : null,
      })

      if (source === 'local' && !adopting) {
        await bindDaemonAppWorkdir(app.id, teamId, localDir)
        await useAppsStore.getState().refreshLocalApps(teamId)
      }
      closeCreateApp()

      // Drop the user straight into a conversation that is already underway.
      // Only once the files exist — an opening message telling the agent to
      // read AGENTS.md is useless if the template was never written.
      if (app.provisionStatus === 'ready') {
        const { startAppFirstSession } = await import('@/lib/apps/app-session')
        const sessionId = await startAppFirstSession(app)
        if (sessionId) {
          useAppsStore.getState().recordAppSession(app.id, sessionId)
          useAppsStore.getState().selectApp(app.id)
          const { useUIStore } = await import('@/stores/ui')
          useUIStore.getState().setSidebarFilter({ kind: 'apps' })
          await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('apps.createError', '创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border-soft bg-paper px-6 py-4">
        <div className="mx-auto flex w-full max-w-[720px] items-center gap-3">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-coral-soft bg-coral/5 px-2.5 text-[12.5px] font-semibold text-coral">
            <AppWindow className="h-3.5 w-3.5" />
            App
          </span>
          <ChevronRight className="h-4 w-4 text-faint" />
          <h2 className="text-[15px] font-bold text-foreground">
            {t('apps.createTitle', '新建')}
          </h2>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-app-name" className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.nameLabel', 'Name')}
            </label>
            <Input
              id="create-app-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apps.namePlaceholder', '起个名字')}
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.sourceLabel', '代码从哪来')}
            </span>
            {/* Across, not down: three stacked cards were most of this
                form's height, and they are short enough to sit side by side. */}
            <div className="grid grid-cols-3 gap-1.5">
              {SOURCES.map((meta) => {
                const selected = source === meta.id
                return (
                  <button
                    key={meta.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={submitting}
                    onClick={() => {
                      setSource(meta.id)
                      setError(null)
                    }}
                    className={cn(CARD, selected ? CARD_ON : CARD_OFF)}
                  >
                    <span
                      className={cn(
                        'text-[13px] font-semibold',
                        selected ? 'text-coral' : 'text-foreground',
                      )}
                    >
                      {t(meta.labelKey, meta.label)}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {t(meta.descriptionKey, meta.description)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {source === 'remote' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="create-app-repo" className="text-[12.5px] font-semibold text-muted-foreground">
                {t('apps.repoLabel', 'Repository URL')}
              </label>
              <Input
                id="create-app-repo"
                autoFocus
                value={gitRemoteUrl}
                onChange={(e) => setGitRemoteUrl(e.target.value)}
                placeholder={t('apps.repoPlaceholder', 'https://github.com/owner/repo.git')}
                disabled={submitting}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={!repoValid}
                className={cn(!repoValid && 'border-amber-500/60')}
              />
              <span className={cn('text-[11.5px]', repoValid ? 'text-faint' : 'text-amber-700')}>
                {repoValid
                  ? t('apps.repoHint', "Fill this in and the repo is cloned as the app's code, with no template written.")
                  : t('apps.repoInvalid', 'Must be an http(s), ssh or git@host:owner/repo.git address.')}
              </span>
            </div>
          )}

          {source === 'local' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold text-muted-foreground">
                {t('apps.sourceLocalLabel', '本地目录')}
              </span>
              <Button
                variant="ghost"
                onClick={() => void pickLocalDir()}
                disabled={submitting || picking}
                className="h-9 justify-start gap-2 rounded-[9px] border border-border-soft bg-paper px-3 text-[13px] font-normal"
              >
                {picking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate">
                  {localDir || t('apps.sourceLocalPick', '选择一个 git 目录')}
                </span>
              </Button>
              <span className="text-[11.5px] text-faint">
                {/*
                  Three states, and the difference matters before they commit to
                  it: an existing remote is recorded, no remote means we make one
                  and push their files to it, and that second one is not
                  something to discover afterwards.
                */}
                {localOrigin
                  ? t('apps.sourceLocalOrigin', '远端：{{url}}', { url: localOrigin })
                  : !localDir
                    ? t('apps.sourceLocalHint', '目录留在原地，不会被移动或覆盖。')
                    : localIsRepo
                      ? t(
                          'apps.sourceLocalWillHostRepo',
                          '这个仓库还没有远端，我们会建一个并把现有提交推上去。未提交的改动不会被提交。',
                        )
                      : t(
                          'apps.sourceLocalWillInit',
                          '这个目录还不是 git 仓库，我们会初始化一个、写一份 .gitignore（node_modules、.env 等）后把内容推上去。',
                        )}
              </span>
            </div>
          )}

          {/*
            Only a new app picks a type. An import's type is `imported`, which
            is not something anyone would choose from a list — it exists so the
            deploy path knows not to provision a database for it.
          */}
          <div className={cn('flex flex-col gap-1.5', source !== 'new' && 'hidden')}>
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.typeLabel', 'Type')}
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              {APP_TYPES.map((meta) => {
                const selected = appType === meta.id
                // Same glyph the app will carry in every list once it exists.
                const Icon = appTypeIcon(meta.id)
                return (
                  <button
                    key={meta.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={submitting}
                    onClick={() => setAppType(meta.id)}
                    className={cn(CARD, selected ? CARD_ON : CARD_OFF)}
                  >
                    <span
                      className={cn(
                        'flex items-center gap-1.5 text-[13px] font-semibold',
                        selected ? 'text-coral' : 'text-foreground',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {t(meta.labelKey, meta.label)}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {t(meta.descriptionKey, meta.description)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.visibilityLabel', 'Visibility')}
            </span>
            <div className="flex gap-2">
              {(['personal', 'team'] as const).map((v) => (
                <label
                  key={v}
                  className={cn(
                    'flex flex-1 cursor-pointer items-center gap-2 rounded-[9px] border px-3 py-2.5 text-[13px] transition-colors',
                    visibility === v
                      ? 'border-coral bg-coral/5 text-foreground'
                      : 'border-border-soft bg-paper text-ink-2 hover:bg-selected/30',
                  )}
                >
                  <input
                    type="radio"
                    name="create-app-visibility"
                    value={v}
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                    disabled={submitting}
                    className="h-3.5 w-3.5 accent-coral"
                  />
                  {v === 'personal'
                    ? t('apps.visibilityPersonal', 'Personal')
                    : t('apps.visibilityTeam', 'Team')}
                </label>
              ))}
            </div>
            <span className="text-[11.5px] text-faint">
              {t(
                'apps.visibilityHint',
                '可见性只控制团队内谁能看到此应用；上线后若未启用登录，任何拿到链接的人均可访问。',
              )}
            </span>
          </div>

          {error && (
            <div className="rounded-[9px] border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700">
              {t('apps.createError', '创建失败')}: {error}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border-soft bg-paper px-6 py-3">
        <div className="mx-auto flex w-full max-w-[720px] items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => closeCreateApp()}
            disabled={submitting}
            className="h-9 rounded-[9px]"
          >
            {t('apps.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="h-9 rounded-[9px] bg-coral px-5 text-white hover:bg-coral/90"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('apps.submit', 'Create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
