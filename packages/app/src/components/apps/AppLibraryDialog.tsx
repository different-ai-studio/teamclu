import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Check, Download, Loader2, Plus, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { resolveAppType } from '@/lib/apps/app-types'
import { appGitKind } from '@/lib/apps/app-list-helpers'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
import type { AppRow } from '@/lib/backend/types'

/**
 * Every app the caller can see — their own and the team's — with the one action
 * the sidebar cannot offer: bringing a copy onto this machine.
 *
 * The sidebar lists only what is already here, which is what makes this dialog
 * necessary: without it a team app nobody had downloaded would be invisible and
 * unreachable. Creating lives here too, for the same reason — the two things
 * that put an app in the sidebar belong in the same place.
 */
interface AppLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
}

function AppLibraryRow({
  app,
  local,
  busy,
  creator,
  onDownload,
}: {
  app: AppRow
  local: boolean
  busy: boolean
  creator: string | null
  onDownload: () => void
}) {
  const { t } = useTranslation()
  const typeMeta = resolveAppType(app.type)
  const gitMeta = appGitKind(app)

  return (
    <div className="flex items-center gap-3 rounded-[9px] border border-border-soft bg-paper px-3 py-2.5">
      <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-semibold text-foreground">{app.name}</span>
        {/*
          Creator, type, and where the code lives. The last one is not
          decoration: it is what says whether this row can be downloaded at all
          — a `local` app exists on exactly one machine.
        */}
        <span className="truncate text-[11.5px] text-muted-foreground">
          {creator || t('apps.libraryUnknownCreator', '未知创建人')}
          {' · '}
          {t(typeMeta.labelKey, typeMeta.label)}
          {' · '}
          {t(gitMeta.key, gitMeta.fallback)}
          {' · '}
          {app.visibility === 'team'
            ? t('apps.visibilityTeam', 'Team')
            : t('apps.visibilityPersonal', 'Personal')}
        </span>
      </div>
      {local ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-faint">
          <Check className="h-3.5 w-3.5" />
          {t('apps.libraryDownloaded', '已在本机')}
        </span>
      ) : (
        <Button
          variant="ghost"
          onClick={onDownload}
          disabled={busy}
          className="h-7 shrink-0 gap-1.5 rounded-[7px] px-2.5 text-[12px]"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t('apps.libraryDownload', '下载')}
        </Button>
      )}
    </div>
  )
}

export function AppLibraryDialog({ open, onOpenChange, teamId }: AppLibraryDialogProps) {
  const { t } = useTranslation()
  const items = useAppsStore((s) => s.items)
  const loading = useAppsStore((s) => s.loading)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const load = useAppsStore((s) => s.load)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)
  const download = useAppsStore((s) => s.download)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [downloading, setDownloading] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const { actors } = useActorDirectory()

  const creatorById = React.useMemo(() => {
    const byId = new Map<string, string>()
    for (const actor of actors) byId.set(actor.id, actor.display_name)
    return byId
  }, [actors])

  // Both halves are refreshed on open: the cloud list can have gained a
  // teammate's app, and the local set can have changed on disk while the dialog
  // was closed.
  React.useEffect(() => {
    if (!open || !teamId) return
    void load(teamId, { force: true })
    void refreshLocalApps(teamId)
  }, [open, teamId, load, refreshLocalApps])

  const localSet = React.useMemo(() => new Set(localAppIds ?? []), [localAppIds])

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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[min(520px,calc(100vh-10rem))] w-[min(880px,calc(100vw-4rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
          <DialogHeader className="border-b border-border-soft bg-paper px-5 py-4">
            <div className="flex items-center gap-3 pr-8">
              <DialogTitle className="flex-1 text-[15px] font-bold text-foreground">
                {t('apps.libraryTitle', '所有应用')}
              </DialogTitle>
              <Button
                onClick={() => setCreateOpen(true)}
                disabled={!teamId}
                className="h-8 gap-1.5 rounded-[9px] bg-coral px-3 text-[12.5px] text-white hover:bg-coral/90"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('apps.create', '新建')}
              </Button>
            </div>
            <DialogDescription className="sr-only">
              {t('apps.libraryDescription', '本人与团队的全部应用，可下载到本机。')}
            </DialogDescription>
          </DialogHeader>

          <div className="border-b border-border-soft px-5 py-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('apps.librarySearch', '搜索应用')}
                aria-label={t('apps.librarySearch', '搜索应用')}
                className="h-8 pl-8 text-[13px]"
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-5 py-4">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('common.loading', 'Loading…')}
              </div>
            ) : items.length === 0 ? (
              <div className="px-1 py-8 text-center text-[12.5px] text-faint">
                {t('apps.empty', '还没有内容')}
              </div>
            ) : visible.length === 0 ? (
              // Distinct from the empty state: "you have no apps" and "none of
              // your apps match this" call for different next moves.
              <div className="px-1 py-8 text-center text-[12.5px] text-faint">
                {t('apps.libraryNoMatch', '没有匹配的应用')}
              </div>
            ) : (
              visible.map((app) => (
                <AppLibraryRow
                  key={app.id}
                  app={app}
                  local={localSet.has(app.id)}
                  busy={downloading === app.id}
                  creator={creatorFor(app)}
                  onDownload={() => void handleDownload(app)}
                />
              ))
            )}
          </div>

          <div className={cn('border-t border-border-soft bg-paper px-5 py-3 text-right')}>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="h-9 rounded-[9px]"
            >
              {t('common.close', '关闭')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} />
    </>
  )
}
