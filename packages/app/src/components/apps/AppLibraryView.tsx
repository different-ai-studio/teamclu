import * as React from 'react'
import { ChevronRight, Download, Loader2, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { useUIStore } from '@/stores/ui'
import { resolveAppType } from '@/lib/apps/app-types'
import { appTypeIcon } from '@/lib/apps/app-type-icon'
import { appGitKind } from '@/lib/apps/app-list-helpers'
import { openCreateApp } from '@/lib/tabs/app-tabs'
import type { AppRow } from '@/lib/backend/types'

/** Column widths are shared by the header and the list so the two line up. */
const COLUMN = 'mx-auto w-full max-w-[820px]'

function TypeMark({ app }: { app: AppRow }) {
  const Icon = appTypeIcon(app.type)
  return (
    // Quiet, not coral: eleven coral discs down one edge is eleven accents, and
    // the palette allows about two. The glyph carries the difference instead.
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-panel text-muted-foreground">
      <Icon className="h-[15px] w-[15px]" />
    </span>
  )
}

function AppMeta({ app, creator }: { app: AppRow; creator: string | null }) {
  const { t } = useTranslation()
  const typeMeta = resolveAppType(app.type)
  const gitMeta = appGitKind(app)

  return (
    // A line under the name now that these are cards: the old right-aligned
    // column existed to fill 500px of empty row, and a card has no such gap.
    //
    // Where the code lives is the load-bearing part: it is what says whether a
    // card can be downloaded at all.
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
      {creator && (
        <>
          <span className="max-w-[10ch] truncate">{creator}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span>{t(typeMeta.labelKey, typeMeta.label)}</span>
      <span aria-hidden>·</span>
      <span>{t(gitMeta.key, gitMeta.fallback)}</span>
    </span>
  )
}

function AppName({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="truncate text-[13px] font-semibold text-foreground">{app.name}</span>
      {/* Only the exception is marked. Personal is the default and labelling
          it put a fourth identical word on every row. */}
      {app.visibility === 'team' && (
        <span className="shrink-0 rounded border border-border px-1 py-px text-[10.5px] text-muted-foreground">
          {t('apps.visibilityTeamBadge', '团队')}
        </span>
      )}
    </span>
  )
}

/**
 * One card. Bordered rather than shadowed, on paper — the palette's rule is
 * that depth comes from a hairline and a background change, never from a drop
 * shadow.
 */
const CARD =
  'group relative flex w-full flex-col gap-2 rounded-[12px] border border-border-soft bg-paper p-3 text-left transition-colors'

/** The grid the cards sit in. Container queries, not viewport ones: the width
 *  that decides how many fit is this column's, and it changes with the right
 *  panel while the window does not. */
const GRID = 'grid gap-2.5 @[520px]:grid-cols-2 @[880px]:grid-cols-3'

/** Top-right of the card: the download button, or the chevron on hover. */
const TRAILING = 'flex shrink-0 items-center justify-end'

/** A row for an app that is already here — clicking it opens it in column two. */
function LocalRow({ app, creator }: { app: AppRow; creator: string | null }) {
  const open = React.useCallback(() => {
    useAppsStore.getState().selectApp(app.id)
    useUIStore.getState().setSidebarFilter({ kind: 'apps' })
  }, [app.id])

  return (
    <button type="button" onClick={open} className={cn(CARD, 'hover:bg-selected/30')}>
      <span className="flex w-full items-center gap-2.5">
        <TypeMark app={app} />
        <AppName app={app} />
        <span className={TRAILING}>
          <ChevronRight className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </span>
      <AppMeta app={app} creator={creator} />
    </button>
  )
}

/**
 * A row for an app whose presence is still unknown — the daemon has not
 * answered yet. No action, because the only two on offer (open it, fetch it)
 * both depend on the answer.
 */
function PendingRow({ app, creator }: { app: AppRow; creator: string | null }) {
  return (
    <div className={cn(CARD, 'opacity-70')}>
      <span className="flex w-full items-center gap-2.5">
        <TypeMark app={app} />
        <AppName app={app} />
      </span>
      <AppMeta app={app} creator={creator} />
    </div>
  )
}

/** A row for an app that is not here. The only thing to do with it is fetch it. */
function RemoteRow({
  app,
  creator,
  busy,
  onDownload,
}: {
  app: AppRow
  creator: string | null
  busy: boolean
  onDownload: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={CARD}>
      <span className="flex w-full items-center gap-2.5">
        <TypeMark app={app} />
        <AppName app={app} />
        <span className={TRAILING}>
          <Button
            variant="ghost"
            onClick={onDownload}
            disabled={busy}
            className="h-7 gap-1.5 rounded-[7px] px-2 text-[12px]"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t('apps.libraryDownload', '下载')}
          </Button>
        </span>
      </span>
      <AppMeta app={app} creator={creator} />
    </div>
  )
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background pb-2 pt-4 text-[10.5px] font-semibold tracking-[0.08em] text-faint">
      <span>{label}</span>
      <span className="font-mono tabular-nums">· {count}</span>
    </div>
  )
}

/**
 * Every app the caller can see — their own and the team's — with the one action
 * column two cannot offer: bringing a copy onto this machine.
 *
 * Column two lists only what is already here, which is what makes this view
 * necessary: without it a team app nobody had downloaded would be invisible and
 * unreachable. It lives in the main column rather than in a dialog because
 * downloading from it changes that column-two list, and watching a row move out
 * of 未在本机 next to the list it lands in is the point.
 *
 * The split into 未在本机 / 已在本机 is what removed the per-row "已在本机" tick
 * that ran down eight of nine rows: the group says it once, and the rows that
 * remain marked are the ones with something to do.
 */
export function AppLibraryView() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const items = useAppsStore((s) => s.items)
  const loading = useAppsStore((s) => s.loading)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const load = useAppsStore((s) => s.load)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const download = useAppsStore((s) => s.download)
  const [downloading, setDownloading] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const { actors } = useActorDirectory()

  const creatorById = React.useMemo(() => {
    const byId = new Map<string, string>()
    for (const actor of actors) byId.set(actor.id, actor.display_name)
    return byId
  }, [actors])

  // Both halves are refreshed when the tab opens: the cloud list can have
  // gained a teammate's app, and the local set can have changed on disk.
  React.useEffect(() => {
    if (!teamId) return
    void load(teamId, { force: true })
    void refreshLocalApps(teamId)
  }, [teamId, load, refreshLocalApps])

  const creatorFor = React.useCallback(
    (app: AppRow) => (app.createdByActorId ? creatorById.get(app.createdByActorId) ?? null : null),
    [creatorById],
  )

  // Name, creator and type all match: in a team list the thing you remember is
  // as often "the one 海港 made" as it is the app's own name.
  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((app) => {
      const typeMeta = resolveAppType(app.type)
      const haystack = [app.name, creatorFor(app) ?? '', typeMeta.label]
      return haystack.some((field) => field.toLowerCase().includes(needle))
    })
  }, [items, query, creatorFor])

  /**
   * Not here first. This view exists to reach apps that are not on this
   * machine; the ones that are, are already one column to the left.
   *
   * `localAppIds === null` is "the daemon has not answered", not "none are
   * local" — grouping on it then would offer a download for every app the user
   * already has. One flat list until it does answer.
   */
  const groups = React.useMemo(() => {
    if (localAppIds === null) return [{ key: 'unknown' as const, label: null, apps: visible }]
    const local = new Set(localAppIds)
    return [
      {
        key: 'away' as const,
        label: t('apps.libraryNotHere', '未在本机'),
        apps: visible.filter((a) => !local.has(a.id)),
      },
      {
        key: 'here' as const,
        label: t('apps.libraryDownloaded', '已在本机'),
        apps: visible.filter((a) => local.has(a.id)),
      },
    ].filter((g) => g.apps.length > 0)
  }, [visible, localAppIds, t])

  const handleDownload = React.useCallback(
    async (app: AppRow) => {
      setDownloading(app.id)
      try {
        await download(app)
      } finally {
        setDownloading(null)
      }
    },
    [download],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border-soft bg-paper px-6 py-4">
        <div className={COLUMN}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-[15px] font-bold tracking-tight text-foreground">
              {t('apps.libraryTitle', '所有应用')}
            </h2>
            <span className="font-mono text-[11px] tabular-nums text-faint">· {items.length}</span>
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('apps.librarySearch', '搜索应用')}
                  aria-label={t('apps.librarySearch', '搜索应用')}
                  className="h-7 w-[180px] pl-8 text-[12.5px]"
                />
              </div>
              <Button
                onClick={() => openCreateApp(t('apps.createTitle', '新建'))}
                disabled={!teamId}
                className="h-7 gap-1.5 rounded-[8px] bg-coral px-2.5 text-[12.5px] text-white hover:bg-coral/90"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('apps.create', '新建')}
              </Button>
            </div>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t('apps.libraryDescription', '本人与团队的全部应用，可下载到本机。')}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {/* Container query, not a viewport one: what decides whether the meta
            column fits is this column's width, and it changes with the right
            panel while the window does not. */}
        <div className={cn(COLUMN, '@container')}>
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-faint">
              {t('apps.empty', '还没有内容')}
            </div>
          ) : groups.length === 0 ? (
            // Distinct from the empty state: "you have no apps" and "none of
            // your apps match this" call for different next moves.
            <div className="py-10 text-center text-[12.5px] text-faint">
              {t('apps.libraryNoMatch', '没有匹配的应用')}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.key}>
                {group.label && <GroupHeading label={group.label} count={group.apps.length} />}
                <div className={cn(GRID, !group.label && 'pt-4')}>
                  {group.apps.map((app) => {
                    if (group.key === 'here') {
                      return <LocalRow key={app.id} app={app} creator={creatorFor(app)} />
                    }
                    if (group.key === 'unknown') {
                      return <PendingRow key={app.id} app={app} creator={creatorFor(app)} />
                    }
                    return (
                      <RemoteRow
                        key={app.id}
                        app={app}
                        creator={creatorFor(app)}
                        busy={downloading === app.id}
                        onDownload={() => void handleDownload(app)}
                      />
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
