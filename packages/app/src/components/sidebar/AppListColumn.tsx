import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronRight, Download, LayoutGrid, Loader2 } from 'lucide-react'
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
import { resolveAppLocality } from '@/lib/apps/app-locality'
import type { AppRow } from '@/lib/backend/types'

function AppRowButton({
  app,
  local,
  downloading,
  onSelect,
  onDownload,
}: {
  app: AppRow
  /** `null` while the daemon has not answered — treated as "here". */
  local: boolean | null
  downloading: boolean
  onSelect: () => void
  onDownload: () => void
}) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const meta = appStatusMeta(app, deploying)
  const typeMeta = resolveAppType(app.type)
  const TypeIcon = appTypeIcon(app.type)
  const publicLive = showsPublicBadge(app)
  // Only a definite "no" changes the row. Unknown keeps the normal one.
  const away = local === false
  const awayLabel = t('apps.notDownloadedBadge', '未下载')

  return (
    <button
      type="button"
      onClick={away ? onDownload : onSelect}
      disabled={downloading}
      title={
        away
          ? t('apps.notDownloadedHint', '这个应用还没下载到本机，点击下载后才能打开它的会话')
          : undefined
      }
      className={cn(
        'group flex w-full items-center gap-3 border-l-2 border-transparent py-2.5 pl-4 pr-3 text-left transition-colors hover:bg-selected/40',
        // Dimmed, not hidden. The row is still the app's place in the list —
        // it just has nothing behind it on this machine yet.
        away && 'opacity-55 hover:opacity-100',
      )}
    >
      {/* One glyph per type, on a quiet disc. Eleven identical coral marks
          down the left edge said nothing about eleven different apps, and
          spent the palette's whole coral budget saying it. */}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-panel text-muted-foreground">
        {deploying || downloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <TypeIcon className="h-[15px] w-[15px]" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{app.name}</span>
          {away && (
            <span
              data-testid="app-row-not-downloaded"
              className="shrink-0 rounded border border-border px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {awayLabel}
            </span>
          )}
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
          before the click rather than after it. An app that is not here does
          something else entirely, so it says that instead. */}
      {away ? (
        <Download className="h-4 w-4 shrink-0 text-faint transition-opacity group-hover:text-muted-foreground" />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  )
}

/**
 * Level one of column two's Apps section: the team's apps, marked by whether
 * each one is on this machine.
 *
 * Picking one that is here swaps this column for that app's sessions
 * (`AppsColumn` decides, on `selectedAppId`). Picking one that is not here
 * downloads it first and only then drills in — an app with no checkout has
 * sessions in the cloud but nothing for an agent to run in, so opening its
 * session list would offer work that cannot happen.
 *
 * The library in column three still exists for what this list cannot do:
 * search, creators, and every app at once regardless of section.
 */
export function AppListColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const items = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const loading = useAppsStore((s) => s.loading)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const load = useAppsStore((s) => s.load)
  const selectApp = useAppsStore((s) => s.selectApp)
  const download = useAppsStore((s) => s.download)
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null)

  const createLabel = t('apps.createTitle', '新建')
  const libraryLabel = t('apps.libraryTitle', '所有应用')

  // Both halves. The nav row loads the cloud list too, but it is mounted once
  // and never asks again — so an empty answer it happened to catch mid
  // server-switch stayed on screen until the app restarted. `load` no longer
  // caches an empty result, which makes opening this column the retry.
  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
    void refreshLocalApps(teamId)
  }, [teamId, load, refreshLocalApps])

  /**
   * Fetch it, then drill in — but only if the files actually landed.
   *
   * `download` surfaces its own reason when it fails (no repo to fetch, daemon
   * down, no access to the forge), so there is nothing to say here; what there
   * is to do is not select an app whose session list still cannot open
   * anything.
   */
  const handleDownload = React.useCallback(
    async (app: AppRow) => {
      if (downloadingId) return
      setDownloadingId(app.id)
      try {
        await download(app)
        if (useAppsStore.getState().localAppIds?.includes(app.id)) selectApp(app.id)
      } finally {
        setDownloadingId(null)
      }
    },
    [download, downloadingId, selectApp],
  )

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
        {/*
          One way in, not two. Creating lives in the library dialog, which is
          also where you go to find an app that is not on this machine — a `+`
          here duplicated that button one click earlier and made the header
          read as two competing actions.
        */}
        <div className="flex shrink-0 items-center gap-0.5">
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
            <AppRowButton
              key={app.id}
              app={app}
              local={resolveAppLocality(localAppIds, app.id)}
              downloading={downloadingId === app.id}
              onSelect={() => selectApp(app.id)}
              onDownload={() => void handleDownload(app)}
            />
          ))
        )}
      </div>
    </div>
  )
}
