import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Loader2,
  Plus,
  Rocket,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
import { revealInFinder } from '@/components/workspace/file-tree-operations'
import { resolveAppType } from '@/lib/app-types'
import { appWorkdirPath } from '@/lib/app-session'
import {
  appStatusMeta,
  deployDisabledReason,
  showsPublicBadge,
} from '@/lib/app-list-helpers'
import type { AppRow } from '@/lib/backend/types'

const APPS_EXPANDED_STORAGE_KEY = 'teamclu.nav.appsExpanded'
const APPS_LIST_MAX_HEIGHT = 'max-h-[min(240px,40vh)]'

function readStoredAppsExpanded(): boolean {
  try {
    // Default collapsed — only expand when the user (or selection auto-expand) wrote 'true'.
    return localStorage.getItem(APPS_EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeStoredAppsExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(APPS_EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

interface AppNavRowProps {
  app: AppRow
  selected: boolean
  rowRef?: React.Ref<HTMLButtonElement>
  onSelect: () => void
}

function AppNavRow({ app, selected, rowRef, onSelect }: AppNavRowProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const meta = appStatusMeta(app, deploying)
  const appTypeMeta = resolveAppType(app.type)
  const isLive = app.fcStatus === 'live' && !!app.fcEndpoint
  const deployBlocked = deployDisabledReason(app)
  const publicLive = showsPublicBadge(app)
  const shareUrl = app.publicUrl ?? app.fcEndpoint

  const handleReveal = React.useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    const path = await appWorkdirPath(app.id, app.teamId)
    if (path) await revealInFinder(path)
  }, [app.id, app.teamId])

  const handleOpenUrl = React.useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!shareUrl) return
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(shareUrl)
  }, [shareUrl])

  const handleDeploy = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void useAppsStore.getState().deploy(app.id)
  }, [app.id])

  return (
    <div className="group relative flex items-stretch pl-3">
      <button
        ref={rowRef}
        type="button"
        onClick={onSelect}
        data-active={selected ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[6px] pl-[9px] pr-16 text-left text-[12.5px] transition-colors',
          selected
            ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
            : 'font-normal text-ink-2 hover:bg-black/[0.04]',
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-coral/10 text-coral">
          {deploying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <AppWindow className="h-3 w-3" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{app.name}</span>
            {publicLive && (
              <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-mono font-semibold uppercase tracking-wide text-muted-foreground">
                {t('apps.publicBadge', '公开')}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 truncate text-[10.5px] text-faint">
            <span className="shrink-0">{t(appTypeMeta.labelKey, appTypeMeta.label)}</span>
            <span>·</span>
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                (meta.dot === 'live' || meta.dot === 'ready') && 'bg-emerald-500',
                meta.dot === 'failed' && 'bg-amber-500',
                meta.dot === 'idle' && 'bg-muted-foreground/40',
              )}
            />
            <span className="truncate">{t(meta.key, meta.fallback)}</span>
          </span>
        </span>
      </button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          aria-label={t('apps.deploy', '部署')}
          disabled={deploying || app.provisionStatus !== 'ready' || !!deployBlocked}
          title={
            deployBlocked
              ? t(
                  deployBlocked,
                  deployBlocked === 'apps.deployDisabledThird'
                    ? '第三方登录尚未支持部署'
                    : '容器运行时暂不支持部署',
                )
              : t('apps.deploy', '部署')
          }
          onClick={handleDeploy}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <Rocket className="h-3.5 w-3.5" />
        </button>
        {isLive && shareUrl && (
          <button
            type="button"
            aria-label={t('apps.openUrl', '打开部署地址')}
            onClick={handleOpenUrl}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label={t('apps.revealInFinder', '在 Finder 打开目录')}
          onClick={handleReveal}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export function AppsNavSection() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const items = useAppsStore((s) => s.items)
  const loading = useAppsStore((s) => s.loading)
  const load = useAppsStore((s) => s.load)
  const selectedAppId = useAppsStore((s) => s.selectedAppId)
  const selectApp = useAppsStore((s) => s.selectApp)

  const [listExpanded, setListExpanded] = React.useState(readStoredAppsExpanded)
  const [createOpen, setCreateOpen] = React.useState(false)
  const selectedRowRef = React.useRef<HTMLButtonElement>(null)
  const prevSelectedAppId = React.useRef<string | null>(null)

  const sectionActive = filter.kind === 'apps'

  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
  }, [teamId, load])

  React.useEffect(() => {
    if (!selectedAppId || selectedAppId === prevSelectedAppId.current) return
    prevSelectedAppId.current = selectedAppId
    setListExpanded(true)
    writeStoredAppsExpanded(true)
    requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
    })
  }, [selectedAppId])

  const toggleListExpanded = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setListExpanded((prev) => {
      const next = !prev
      writeStoredAppsExpanded(next)
      return next
    })
  }, [])

  const selectAppsSection = React.useCallback(() => {
    setFilter({ kind: 'apps' })
  }, [setFilter])

  const handleSelectApp = React.useCallback(
    (app: AppRow) => {
      selectApp(app.id)
      setFilter({ kind: 'apps' })
    },
    [selectApp, setFilter],
  )

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-lg pr-1 transition-[background-color,box-shadow,color] duration-150',
            sectionActive && 'bg-paper shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]',
          )}
        >
          <button
            type="button"
            onClick={selectAppsSection}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-left text-[13px]',
              sectionActive ? 'font-semibold text-foreground' : 'font-normal text-ink-2 hover:bg-black/[0.04]',
            )}
          >
            <AppWindow
              className={cn(
                'h-[15px] w-[15px] shrink-0',
                sectionActive ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{t('sidebar.apps', '应用')}</span>
            <span className="text-[10.5px] font-mono tabular-nums text-faint">· {items.length}</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setCreateOpen(true)
            }}
            disabled={!teamId}
            title={t('apps.create', '新建')}
            aria-label={t('apps.create', '新建')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-expanded={listExpanded}
            aria-label={listExpanded ? t('common.collapse', '收起') : t('common.expand', '展开')}
            onClick={toggleListExpanded}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-faint transition-colors hover:bg-black/[0.04] hover:text-ink-2"
          >
            {listExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {listExpanded && (
          <div className={cn('min-h-0 overflow-y-auto overflow-x-hidden', APPS_LIST_MAX_HEIGHT)}>
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('common.loading', 'Loading…')}
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">{t('apps.empty', '还没有内容')}</div>
            ) : (
              items.map((app) => (
                <AppNavRow
                  key={app.id}
                  app={app}
                  selected={selectedAppId === app.id}
                  rowRef={selectedAppId === app.id ? selectedRowRef : undefined}
                  onSelect={() => handleSelectApp(app)}
                />
              ))
            )}
          </div>
        )}
      </div>

      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} />
    </>
  )
}
