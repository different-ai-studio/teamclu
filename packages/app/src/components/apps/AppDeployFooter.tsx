import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deployDisabledReason } from '@/lib/app-list-helpers'
import { openAppPreview } from '@/lib/tabs/app-tabs'
import { useAppsStore, type DeployPhase } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

const LINGER_MS = 800

function phasePercent(phase: DeployPhase): number {
  switch (phase) {
    case 'prepare':
      return 15
    case 'build':
      return 55
    case 'finalize':
      return 90
    case 'done':
      return 100
  }
}

function phaseLabelKey(phase: DeployPhase): string {
  switch (phase) {
    case 'prepare':
      return 'apps.deployPhase.prepare'
    case 'build':
      return 'apps.deployPhase.build'
    case 'finalize':
      return 'apps.deployPhase.finalize'
    case 'done':
      return 'apps.deployPhase.done'
  }
}

interface AppDeployFooterProps {
  app: AppRow
}

/**
 * Bottom bar for the app sessions column — deploy + preview, with progress.
 *
 * Same slot and chrome as Knowledge's sync footer and Skills' scan paths.
 */
export function AppDeployFooter({ app }: AppDeployFooterProps) {
  const { t } = useTranslation()
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const progress = useAppsStore((s) => s.deployProgressByAppId[app.id])
  const deploy = useAppsStore((s) => s.deploy)

  const deployBlocked = deployDisabledReason(app)
  const deployDisabled = deploying || app.provisionStatus !== 'ready' || !!deployBlocked
  const previewUrl = app.publicUrl ?? app.fcEndpoint
  const previewDisabled = !previewUrl || app.fcStatus !== 'live'

  const [showBar, setShowBar] = React.useState(false)
  React.useEffect(() => {
    if (deploying || progress?.phase === 'done') {
      setShowBar(true)
      return
    }
    if (!showBar) return
    const id = setTimeout(() => setShowBar(false), LINGER_MS)
    return () => clearTimeout(id)
  }, [deploying, progress?.phase, showBar])

  const percent = progress ? phasePercent(progress.phase) : 0
  const pulse = progress?.phase === 'build'

  return (
    <div
      className="shrink-0 border-t border-border bg-panel/60 px-3 py-2"
      data-testid="app-deploy-footer"
    >
      {showBar && (
        <div className="mb-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {deploying ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              {progress
                ? t(
                    phaseLabelKey(progress.phase),
                    progress.phase === 'prepare'
                      ? '准备部署…'
                      : progress.phase === 'build'
                        ? '构建并上传…'
                        : progress.phase === 'finalize'
                          ? '收尾上线…'
                          : '部署完成',
                  )
                : t('apps.deploying', '部署中…')}
            </span>
            {progress && progress.phase !== 'build' && (
              <span className="shrink-0 tabular-nums text-faint">{percent}%</span>
            )}
          </div>
          <span className="block h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]">
            <span
              className={cn(
                'block h-full rounded-full bg-foreground/40 transition-[width] duration-200',
                pulse && 'w-1/3 animate-pulse',
              )}
              style={!pulse ? { width: `${percent}%` } : undefined}
            />
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <button
          type="button"
          disabled={deployDisabled}
          onClick={() => void deploy(app.id)}
          data-testid="app-deploy-footer-deploy"
          className={cn(
            'inline-flex items-center gap-1 transition-colors hover:text-foreground hover:underline underline-offset-2',
            deployDisabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground hover:no-underline',
          )}
        >
          {deploying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {deploying ? t('apps.deploying', '部署中…') : t('apps.deploy', '部署')}
        </button>
        <span className="text-faint" aria-hidden>
          ·
        </span>
        <button
          type="button"
          disabled={previewDisabled}
          onClick={() => openAppPreview(app)}
          data-testid="app-deploy-footer-preview"
          className={cn(
            'transition-colors hover:text-foreground hover:underline underline-offset-2',
            previewDisabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground hover:no-underline',
          )}
        >
          {t('apps.preview', '预览')}
        </button>
      </div>

      {deployBlocked && (
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          {t(
            deployBlocked,
            deployBlocked === 'apps.deployDisabledThird'
              ? '第三方登录尚未支持部署'
              : '容器运行时暂不支持部署',
          )}
        </p>
      )}
    </div>
  )
}
