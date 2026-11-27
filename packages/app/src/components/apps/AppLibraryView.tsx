import * as React from 'react'
import { AppWindow, Check, Download, Loader2, Plus, Search } from 'lucide-react'
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
import { formatAppCode } from '@/lib/apps/app-code'
import { openCreateApp } from '@/lib/tabs/app-tabs'
import { isSharedByMe } from '@/lib/apps/app-relationship'
import { useAppRelationshipLabel, type AppRelationshipLabel } from '@/lib/apps/use-app-relationship-label'
import { useMyMemberActorId } from '@/stores/app-relationship-filter'
import type { AppRow } from '@/lib/backend/types'

/** Both marks beside the name wear the same pill. */
const MARK = 'shrink-0 rounded border border-border px-1 py-px text-[10.5px] font-normal text-muted-foreground'

/** One row, on the skills marketplace's pattern: a hover row, not a card. */
const ROW = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-selected'

function AppRowBody({
  app,
  creator,
  relationLabel,
  shared,
}: {
  app: AppRow
  creator: string | null
  relationLabel: AppRelationshipLabel
  /** My own app, visible to the whole team. */
  shared: boolean
}) {
  const { t } = useTranslation()
  const Icon = appTypeIcon(app.type)
  const typeMeta = resolveAppType(app.type)
  const gitMeta = appGitKind(app)
  return (
    <>
      {/* Quiet, not coral: a list of coral discs is a list of accents. */}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-panel text-muted-foreground">
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{app.name}</span>
          {/* My relationship to the app — the same word column two uses. No
              filter here, so every row says it. */}
          <span data-testid="app-card-relationship" title={relationLabel.hint ?? undefined} className={MARK}>
            {relationLabel.label}
          </span>
          {shared && (
            <span
              data-testid="app-card-shared"
              title={t('apps.visibilityTeamHint', '团队里每个人都能在应用列表里看到它。')}
              className={MARK}
            >
              {t('apps.sharedBadge', '已共享')}
            </span>
          )}
        </span>
        {/* Where the code lives is the load-bearing part: it says whether an
            app can be downloaded at all. */}
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          {creator && (
            <>
              <span className="max-w-[10ch] truncate">{creator}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{t(typeMeta.labelKey, typeMeta.label)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{t(gitMeta.key, gitMeta.fallback)}</span>
        </span>
      </span>
    </>
  )
}

/**
 * Every app the caller can see — their own and the team's — in one list, with
 * search and creators.
 *
 * It is the Apps section's main view (see `section-mode.ts`), as the
 * marketplace is for skills, and it is laid out like the marketplace: a header
 * with search, then plain hover rows. No relationship filter: column two
 * already splits 本机 / 我的 / 受邀, and each row here names its own.
 *
 * Each row says for itself whether the app is here: 已在本机 (click to open it
 * in column two) or a 下载 button.
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
  const myActorId = useMyMemberActorId()
  const relationLabelFor = useAppRelationshipLabel()

  const creatorById = React.useMemo(() => {
    const byId = new Map<string, string>()
    for (const actor of actors) byId.set(actor.id, actor.display_name)
    return byId
  }, [actors])

  // Both halves are refreshed when it opens: the cloud list can have gained a
  // teammate's app, and the local set can have changed on disk.
  React.useEffect(() => {
    if (!teamId) return
    void load(teamId, { force: true })
    void refreshLocalApps(teamId)
  }, [teamId, load, refreshLocalApps])

  const creatorFor = React.useCallback(
    (app: AppRow) => (app.createdByActorId ? creatorById.get(app.createdByActorId) ?? null : null),
    [creatorById],
  )

  // Name, creator, type and public code all match: in a team list the thing
  // you remember is as often "the one 海港 made" as it is the app's own name.
  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((app) => {
      const typeMeta = resolveAppType(app.type)
      const haystack = [app.name, creatorFor(app) ?? '', typeMeta.label, formatAppCode(app.appCode) ?? '']
      return haystack.some((field) => field.toLowerCase().includes(needle))
    })
  }, [items, query, creatorFor])

  /** `null` is "the daemon has not answered", not "none are local". */
  const localSet = React.useMemo(() => (localAppIds === null ? null : new Set(localAppIds)), [localAppIds])

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

  const open = React.useCallback((app: AppRow) => {
    useAppsStore.getState().selectApp(app.id)
    useUIStore.getState().setSidebarFilter({ kind: 'apps' })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region="deep">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel text-muted-foreground">
          <AppWindow className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1 text-[15px] font-bold text-foreground">
          {t('apps.libraryTitle', '所有应用')}
          <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-faint">· {items.length}</span>
        </div>
        <div className="relative w-40">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('apps.librarySearch', '搜索应用')}
            aria-label={t('apps.librarySearch', '搜索应用')}
            className="h-8 pl-7 text-[12.5px]"
          />
        </div>
        <Button
          onClick={() => openCreateApp(t('apps.createTitle', '新建'))}
          disabled={!teamId}
          className="h-8 gap-1.5 rounded-[8px] bg-coral px-2.5 text-[12.5px] text-white hover:bg-coral/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('apps.create', '新建')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
            {t('apps.empty', '还没有内容')}
          </div>
        ) : visible.length === 0 ? (
          // Distinct from the empty state: "you have no apps" and "none of
          // your apps match this" call for different next moves.
          <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
            {t('apps.libraryNoMatch', '没有匹配的应用')}
          </div>
        ) : (
          <ul className="space-y-1">
            {visible.map((app) => {
              const body = (
                <AppRowBody
                  app={app}
                  creator={creatorFor(app)}
                  relationLabel={relationLabelFor(app)}
                  shared={isSharedByMe(app, myActorId)}
                />
              )
              // Unknown presence: no action, because both on offer (open it,
              // fetch it) depend on the answer.
              if (localSet === null) {
                return (
                  <li key={app.id} className={cn(ROW, 'hover:bg-transparent opacity-70')}>
                    {body}
                  </li>
                )
              }
              if (localSet.has(app.id)) {
                return (
                  <li key={app.id}>
                    <button type="button" onClick={() => open(app)} className={ROW}>
                      {body}
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        {t('apps.libraryHere', '已在本机')}
                      </span>
                    </button>
                  </li>
                )
              }
              const busy = downloading === app.id
              return (
                <li key={app.id} className={ROW}>
                  {body}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDownload(app)}
                    disabled={busy}
                    className="h-7 shrink-0 gap-1.5 text-[12px]"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {t('apps.libraryDownload', '下载')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
