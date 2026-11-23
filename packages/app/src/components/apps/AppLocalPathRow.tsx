import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  Folder,
  FolderX,
  Loader2,
  SquareArrowOutUpRight,
  SquareTerminal,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isTauri } from '@/lib/utils'
import { OPEN_WITH_TARGETS, openPathWithApp, type OpenWithTargetId } from '@/lib/apps/open-with-app'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

/**
 * Where this app's code sits on this computer, with a copy button and an
 * "open in…" menu for the usual editors and agents.
 *
 * The path comes from the daemon (it owns the checkout layout), so it is read,
 * not derived. An app with no checkout here says so instead of showing the
 * folder the daemon WOULD use — copying a path that does not exist is a trap.
 */
export function AppLocalPathRow({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const isLocal = localAppIds === null ? null : localAppIds.includes(app.id)
  const [workdir, setWorkdir] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setWorkdir(null)
    void import('@/lib/daemon/daemon-local-client')
      .then(({ daemonAppWorkdir }) => daemonAppWorkdir(app.id, app.teamId))
      .then((info) => {
        if (!cancelled) setWorkdir(info?.workdir ?? null)
      })
      .catch(() => {
        if (!cancelled) setWorkdir(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [app.id, app.teamId, isLocal])

  React.useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  const path = isLocal === false ? null : workdir

  const copy = async () => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
    } catch (error) {
      toast.error(t('apps.localPath.copyFailed', '复制失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const openWith = async (target: OpenWithTargetId, label: string) => {
    if (!path) return
    try {
      await openPathWithApp(path, target)
    } catch (error) {
      toast.error(t('apps.localPath.openFailed', '没能用 {{app}} 打开', { app: label }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div data-testid="app-local-path">
      {loading ? (
        <div className="flex h-8 items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      ) : !path ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <FolderX className="h-3.5 w-3.5 shrink-0 text-faint" />
          {t('apps.localPath.none', '这台电脑上还没有这个应用的代码')}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="group flex items-center gap-1 rounded-[7px] border border-border-soft bg-panel/60 py-1 pl-2.5 pr-1">
            <Folder className="h-3.5 w-3.5 shrink-0 text-faint" />
            <code
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground [direction:rtl] text-left"
              title={path}
              data-testid="app-local-path-value"
            >
              {/* rtl keeps the tail (the app's own folder) visible when the
                  column is too narrow; the bdi stops it reordering the path. */}
              <bdi>{path}</bdi>
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-[5px] text-muted-foreground hover:text-foreground"
              aria-label={t('apps.localPath.copy', '复制路径')}
              title={t('apps.localPath.copy', '复制路径')}
              onClick={() => void copy()}
              data-testid="app-local-path-copy"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          {isTauri() && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-full justify-between rounded-[7px] px-2.5 text-[12.5px] font-normal"
                  data-testid="app-local-path-open-with"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SquareArrowOutUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('apps.localPath.openWith', '用其他应用打开')}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
              >
                {OPEN_WITH_TARGETS.map((target) => {
                  const Icon = target.id === 'claude' ? SquareTerminal : Code2
                  return (
                    <DropdownMenuItem
                      key={target.id}
                      onSelect={() => void openWith(target.id, target.label)}
                      data-testid={`app-local-path-open-${target.id}`}
                      className="gap-2 text-[12.5px]"
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {target.label}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  )
}
