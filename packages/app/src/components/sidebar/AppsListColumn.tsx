import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Loader2,
  Plus,
  Ellipsis,
  Rocket,
  Eye,
  ExternalLink,
  Copy,
  FolderOpen,
  RotateCw,
  Pencil,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { revealInFinder } from '@/components/workspace/file-tree-operations'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
import { resolveAppType } from '@/lib/app-types'
import { appWorkdirPath, ensureAppSession } from '@/lib/app-session'
import type { AppRow } from '@/lib/backend/types'

async function comingSoon(label: string): Promise<void> {
  const { toast } = await import('sonner')
  toast(`${label}：即将推出`)
}

/**
 * Whether a "Reseed" action should be offered for an app in the given
 * provision state. An app whose files were never written (`pending`, or the
 * legacy `repo_created`) or whose seed failed (`error`) can be reseeded;
 * `ready` and `seeding` are excluded. Exported as a pure predicate so the
 * gating logic is unit-testable without rendering the component.
 */
export function canReseed(status: string): boolean {
  return status === 'pending' || status === 'repo_created' || status === 'error'
}

/** i18n key when deploy is blocked by auth/runtime policy, or null when allowed. */
export function deployDisabledReason(
  app: Pick<AppRow, 'authMode' | 'runtime'>,
): string | null {
  if (app.authMode === 'third') return 'apps.deployDisabledThird'
  if (app.runtime === 'container') return 'apps.deployDisabledContainer'
  return null
}

/** Show the public-access badge on live apps with no auth gate. */
export function showsPublicBadge(
  app: Pick<AppRow, 'authMode' | 'fcStatus'>,
): boolean {
  return app.authMode === 'none' && app.fcStatus === 'live'
}

interface RowProps {
  app: AppRow
  onClick: () => void
  onRename: (app: AppRow) => void
}

function provisionMeta(status: string): { dot: 'ready' | 'failed' | 'idle'; key: string; fallback: string } {
  if (status === 'ready') return { dot: 'ready', key: 'apps.ready', fallback: 'Ready' }
  if (status === 'error' || status === 'failed') return { dot: 'failed', key: 'apps.error', fallback: 'Failed' }
  return { dot: 'idle', key: 'apps.provisioning', fallback: 'Provisioning…' }
}

/**
 * The single status line a row shows, resolved from both lifecycles at once:
 * an in-flight deploy, then the persisted deploy state (`fcStatus`), then the
 * repo/seed state (`provisionStatus`). Persisted deploy states used to be
 * invisible unless they were `live`, so a deploy that died mid-flight — or one
 * still running in another window — read as a plain "Ready" app.
 *
 * Exported as a pure helper so the precedence is unit-testable without
 * rendering the column.
 */
export function appStatusMeta(
  app: Pick<AppRow, 'provisionStatus' | 'fcStatus' | 'fcEndpoint'>,
  deploying: boolean,
): { dot: 'live' | 'ready' | 'failed' | 'idle'; key: string; fallback: string } {
  if (deploying) return { dot: 'idle', key: 'apps.deploying', fallback: '部署中…' }
  if (app.fcStatus === 'live' && app.fcEndpoint) return { dot: 'live', key: 'apps.live', fallback: '已上线' }
  if (app.fcStatus === 'deploy_error') return { dot: 'failed', key: 'apps.deployFailed', fallback: '部署失败' }
  if (app.fcStatus === 'awaiting_build' || app.fcStatus === 'building' || app.fcStatus === 'deploying') {
    return { dot: 'idle', key: 'apps.deploying', fallback: '部署中…' }
  }
  return provisionMeta(app.provisionStatus)
}

function AppItemRow({ app, onClick, onRename }: RowProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const appSessionId = useAppsStore((s) => s.sessionIdByAppId[app.id] ?? null)
  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId)
  const selected = !!appSessionId && appSessionId === activeSessionId
  const meta = appStatusMeta(app, deploying)
  const appTypeMeta = resolveAppType(app.type)
  const isLive = app.fcStatus === 'live' && !!app.fcEndpoint
  const deployBlocked = deployDisabledReason(app)
  const publicLive = showsPublicBadge(app)

  const handleReveal = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    const path = await appWorkdirPath(app.id, app.teamId)
    if (path) await revealInFinder(path)
  }, [app.id, app.teamId])

  // The address we hand the user is the vanity one when this deployment has an
  // apps domain — `publicUrl` is null otherwise, and the raw Function Compute
  // trigger URL (random suffix and all) remains the only way in.
  const shareUrl = app.publicUrl ?? app.fcEndpoint

  const handleOpenUrl = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (!shareUrl) return
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(shareUrl)
  }, [shareUrl])

  const handleCopyUrl = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
    } catch {
      const { toast } = await import('sonner')
      toast.error(t('apps.urlCopyFailed', '复制失败'))
    }
  }, [shareUrl, t])

  return (
    <div className="group relative flex items-stretch">
      <button
        type="button"
        onClick={onClick}
        data-active={selected ? 'true' : 'false'}
        className={cn(
          'flex w-full items-center gap-3 border-l-2 border-transparent py-2.5 pl-4 pr-10 text-left transition-colors hover:bg-selected/40',
          selected && 'border-coral bg-selected',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          {deploying ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <AppWindow className="h-[15px] w-[15px]" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-foreground">{app.name}</span>
            {publicLive && (
              <span
                className="shrink-0 rounded border border-border px-1.5 py-px text-[9.5px] font-mono font-semibold uppercase tracking-wide text-muted-foreground"
                title={t('apps.publicBadgeHint', '未启用登录；任何拿到链接的人均可访问（与上方可见性无关）')}
              >
                {t('apps.publicBadge', '公开')}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            <span className="shrink-0">{t(appTypeMeta.labelKey, appTypeMeta.label)}</span>
            <span className="shrink-0 text-faint">·</span>
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('apps.actions', '操作')}
            className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            className="text-[13px]"
            disabled={deploying || app.provisionStatus !== 'ready' || !!deployBlocked}
            title={
              deployBlocked
                ? t(deployBlocked, deployBlocked === 'apps.deployDisabledThird'
                  ? '第三方登录尚未支持部署'
                  : '容器运行时暂不支持部署')
                : undefined
            }
            onClick={(e) => {
              e.stopPropagation()
              void useAppsStore.getState().deploy(app.id)
            }}
          >
            <Rocket className="mr-2 h-3.5 w-3.5" />
            {t('apps.deploy', '部署')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[13px]"
            onClick={(e) => {
              e.stopPropagation()
              void comingSoon(t('apps.localPreview', '本地预览'))
            }}
          >
            <Eye className="mr-2 h-3.5 w-3.5" />
            {t('apps.localPreview', '本地预览')}
          </DropdownMenuItem>
          {isLive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-[13px]" onClick={handleOpenUrl}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {t('apps.openUrl', '打开部署地址')}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-[13px]" onClick={handleCopyUrl}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                {t('apps.copyUrl', '复制部署地址')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-[13px]" onClick={handleReveal}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" />
            {t('apps.revealInFinder', '在 Finder 打开目录')}
          </DropdownMenuItem>
          {canReseed(app.provisionStatus) && (
            <DropdownMenuItem
              className="text-[13px]"
              onClick={(e) => {
                e.stopPropagation()
                void useAppsStore.getState().reseed(app.id)
              }}
            >
              <RotateCw className="mr-2 h-3.5 w-3.5" />
              {t('apps.reseed', 'Reseed')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-[13px]"
            onClick={(e) => {
              e.stopPropagation()
              onRename(app)
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t('apps.rename', '重命名')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[13px] text-destructive focus:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              void comingSoon(t('apps.delete', '删除'))
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t('apps.delete', '删除')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RenameAppDialog({
  app,
  onClose,
}: {
  app: AppRow | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  React.useEffect(() => {
    if (app) setName(app.name)
  }, [app])

  const submit = React.useCallback(() => {
    if (!app) return
    const trimmed = name.trim()
    if (trimmed && trimmed !== app.name) {
      void useAppsStore.getState().rename(app.id, trimmed)
    }
    onClose()
  }, [app, name, onClose])

  return (
    <Dialog open={!!app} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{t('apps.rename', '重命名')}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit() }
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel', '取消')}</Button>
          <Button onClick={submit}>{t('common.save', '保存')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AppsListColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const items = useAppsStore((s) => s.items)
  const loading = useAppsStore((s) => s.loading)
  const load = useAppsStore((s) => s.load)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [renameApp, setRenameApp] = React.useState<AppRow | null>(null)

  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
  }, [teamId, load])

  const openApp = React.useCallback(async (app: AppRow) => {
    try {
      const sessionId = await ensureAppSession(app)
      if (!sessionId) return
      useAppsStore.getState().recordAppSession(app.id, sessionId)
      // Keep column 2 on the Apps list — the app row is what the user is
      // navigating from, and bouncing to the session list loses that context.
      await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
    } catch (e) {
      console.error('[AppsListColumn] failed to open app', e)
    }
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t('apps.title', '演示及 APP')}
            <span className="font-mono text-[11px] font-normal text-faint"> · {items.length}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!teamId}
          title={t('apps.create', '新建')}
          aria-label={t('apps.create', '新建')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-selected/40 hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('apps.empty', '还没有内容')}
          </div>
        ) : (
          items.map((app) => (
            <AppItemRow
              key={app.id}
              app={app}
              onClick={() => void openApp(app)}
              onRename={setRenameApp}
            />
          ))
        )}
      </div>

      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} />
      <RenameAppDialog app={renameApp} onClose={() => setRenameApp(null)} />
    </div>
  )
}
