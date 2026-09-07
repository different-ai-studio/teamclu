import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronRight, LayoutGrid, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { openAppLibrary, openCreateApp } from '@/lib/tabs/app-tabs'
import { resolveAppType } from '@/lib/apps/app-types'
import { appTypeIcon } from '@/lib/apps/app-type-icon'
import { appStatusMeta, showsPublicBadge } from '@/lib/apps/app-list-helpers'
import type { AppRow } from '@/lib/backend/types'

function AppRowButton({ app, onSelect }: { app: AppRow; onSelect: () => void }) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const meta = appStatusMeta(app, deploying)
  const typeMeta = resolveAppType(app.type)
  const TypeIcon = appTypeIcon(app.type)
  const publicLive = showsPublicBadge(app)

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full items-center gap-3 border-l-2 border-transparent py-2.5 pl-4 pr-3 text-left transition-colors hover:bg-selected/40"
    >
      {/* One glyph per type, on a quiet disc. Eleven identical coral marks
          down the left edge said nothing about eleven different apps, and
          spent the palette's whole coral budget saying it. */}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-panel text-muted-foreground">
        {deploying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <TypeIcon className="h-[15px] w-[15px]" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{app.name}</span>
          {publicLive && (
            <span className="shrink-0 rounded border border-border px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('apps.publicBadge', '公开')}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
          <span className="shrink-0">{t(typeMeta.labelKey, typeMeta.label)}</span>
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
      {/* The row drills one level deeper into this same column, which is not
          something the other column-two lists do — the chevron is what says so
          before the click rather than after it. */}
      <ChevronRight className="h-4 w-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

/**
 * Level one of column two's Apps section: the apps on this machine.
 *
 * Picking one swaps this column for that app's sessions (`AppsColumn` decides,
 * on `selectedAppId`), which is why nothing here opens a session or a dialog
 * beyond creating. The library — every app the team has, downloadable — is not
 * a list of what is here, so it opens in column three instead of replacing this.
 */
export function AppListColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const allItems = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const loading = useAppsStore((s) => s.loading)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const selectApp = useAppsStore((s) => s.selectApp)

  const createLabel = t('apps.createTitle', '新建')
  const libraryLabel = t('apps.libraryTitle', '所有应用')

  // The cloud list is loaded by the nav row (always mounted); only the local
  // half can have changed on disk while this column was closed.
  React.useEffect(() => {
    if (!teamId) return
    void refreshLocalApps(teamId)
  }, [teamId, refreshLocalApps])

  /**
   * Only what is actually on this machine. Everything else lives in the library
   * behind a download.
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

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div
        className="flex items-center justify-between gap-2 border-b border-border px-4 py-3"
        data-tauri-drag-region
      >
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t('sidebar.apps', '应用')}
            <span className="font-mono text-[11px] font-normal text-faint"> · {items.length}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => openCreateApp(createLabel)}
            disabled={!teamId}
            title={t('apps.create', '新建')}
            aria-label={t('apps.create', '新建')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-selected/40 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => openAppLibrary(libraryLabel)}
            disabled={!teamId}
            title={libraryLabel}
            aria-label={libraryLabel}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-selected/40 hover:text-foreground disabled:opacity-40"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">{t('apps.empty', '还没有内容')}</p>
            {/*
              Two ways out, because there are two reasons this list is empty:
              nothing has been created yet, or the team's apps are simply not on
              this machine — and the second is the more common one.
            */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCreateApp(createLabel)}
                disabled={!teamId}
                className="rounded-[8px] bg-coral px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
              >
                {t('apps.create', '新建')}
              </button>
              <button
                type="button"
                onClick={() => openAppLibrary(libraryLabel)}
                disabled={!teamId}
                className="rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-foreground hover:bg-selected/40 disabled:opacity-40"
              >
                {t('apps.libraryTitle', '所有应用')}
              </button>
            </div>
          </div>
        ) : (
          items.map((app) => (
            <AppRowButton key={app.id} app={app} onSelect={() => selectApp(app.id)} />
          ))
        )}
      </div>
    </div>
  )
}
