import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { lazyNamed } from '@/lib/lazy-component'
import { useEverTrue } from '@/hooks/use-ever-true'

const AppLibraryDialog = lazyNamed(
  () => import('@/components/apps/AppLibraryDialog'),
  'AppLibraryDialog',
)
import { resolveAppType } from '@/lib/app-types'
import { appStatusMeta, showsPublicBadge } from '@/lib/app-list-helpers'
import type { AppRow } from '@/lib/backend/types'

const APPS_EXPANDED_STORAGE_KEY = 'teamclu.nav.appsExpanded'
/**
 * The list takes whatever vertical space is left in the rail.
 *
 * It used to be capped at 240px, which left most of the column empty below it
 * — the rail scrolled as a whole, so a fixed cap was the only thing that could
 * bound the list. The rail is a bounded flex column now, and this is the one
 * part of it that should grow.
 */
const APPS_LIST_GROW = 'min-h-0 flex-1'

function readStoredAppsExpanded(): boolean {
  try {
    // Default collapsed, and nothing but the chevron ever changes that — the
    // stored value only ever comes from a deliberate click.
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

/**
 * A name and a status line — no actions.
 *
 * Deploy / open / reveal used to live here as a hover strip, which cost the row
 * a 64px right gutter permanently. At this column's width that truncated most
 * app names to a few characters to make room for buttons that were invisible
 * until hover. They now live in the second column's header, where there is room
 * for labels and where the app they act on is unambiguous.
 */
function AppNavRow({ app, selected, rowRef, onSelect }: AppNavRowProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const meta = appStatusMeta(app, deploying)
  const appTypeMeta = resolveAppType(app.type)
  const publicLive = showsPublicBadge(app)

  return (
    <div className="group relative flex items-stretch pl-3">
      <button
        ref={rowRef}
        type="button"
        onClick={onSelect}
        data-active={selected ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[6px] pl-[9px] pr-2 text-left text-[12.5px] transition-colors',
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
    </div>
  )
}

export function AppsNavSection() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const allItems = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const loading = useAppsStore((s) => s.loading)
  const load = useAppsStore((s) => s.load)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const selectedAppId = useAppsStore((s) => s.selectedAppId)
  const selectApp = useAppsStore((s) => s.selectApp)

  const [listExpanded, setListExpanded] = React.useState(readStoredAppsExpanded)
  const [libraryOpen, setLibraryOpen] = React.useState(false)
  // Loads the library dialog's chunk on first open; stays mounted after so the
  // close animation and dialog state behave as with a permanent mount.
  const mountLibraryDialog = useEverTrue(libraryOpen)
  const selectedRowRef = React.useRef<HTMLButtonElement>(null)
  const prevSelectedAppId = React.useRef<string | null>(null)

  const sectionActive = filter.kind === 'apps'

  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
    void refreshLocalApps(teamId)
  }, [teamId, load, refreshLocalApps])

  /**
   * Only what is actually on this machine. Everything else lives in the library
   * dialog behind a download.
   *
   * `localAppIds === null` means the daemon has not answered yet, which is not
   * the same as "nothing is local": showing an empty list then would tell the
   * user their apps are gone every time the daemon is slow to start.
   */
  const items = React.useMemo(() => {
    if (localAppIds === null) return allItems
    const local = new Set(localAppIds)
    return allItems.filter((app) => local.has(app.id))
  }, [allItems, localAppIds])

  React.useEffect(() => {
    if (!selectedAppId || selectedAppId === prevSelectedAppId.current) return
    prevSelectedAppId.current = selectedAppId
    // Selecting an app never opens this list. The chevron is the only thing
    // that does, so the row keeps whatever height the user chose for it — an
    // app opened from anywhere else no longer unfolds a list underneath the
    // rows above it.
    //
    // The scroll still runs: when the list *is* open, a selection made
    // elsewhere should bring its row into view. Collapsed, the ref is null and
    // this is a no-op.
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
      <div className={cn('flex min-h-0 flex-col gap-0.5', listExpanded && 'flex-1')}>
        <div
          className={cn(
            'flex w-full shrink-0 items-center gap-1 rounded-lg pr-1 transition-[background-color,box-shadow,color] duration-150',
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
          {/*
            The library, not a create button. Creating is one of two ways an app
            lands in this list — downloading a team app is the other — and both
            live behind here so the list itself stays a list of what is present.
          */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setLibraryOpen(true)
            }}
            disabled={!teamId}
            title={t('apps.libraryTitle', '所有应用')}
            aria-label={t('apps.libraryTitle', '所有应用')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground disabled:opacity-40"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
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
          <div className={cn('min-h-0 overflow-y-auto overflow-x-hidden', APPS_LIST_GROW)}>
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

      {mountLibraryDialog ? (
        <React.Suspense fallback={null}>
          <AppLibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} teamId={teamId} />
        </React.Suspense>
      ) : null}
    </>
  )
}
