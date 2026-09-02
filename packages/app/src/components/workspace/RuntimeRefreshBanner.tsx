import { useTranslation } from 'react-i18next'
import { AlertCircle, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatRuntimeRefreshChangeKinds, runtimeRefreshNeedsBanner } from '@/lib/workspace-runtime-refresh-labels'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

export function RuntimeRefreshWorkspaceBanner() {
  const { t } = useTranslation()
  const refresh = useWorkspaceRuntimeRefreshStore((s) => s.refresh)
  const dismissedAt = useWorkspaceRuntimeRefreshStore((s) => s.dismissedAt)
  const dismissBanner = useWorkspaceRuntimeRefreshStore((s) => s.dismissBanner)

  if (!runtimeRefreshNeedsBanner(refresh?.status)) {
    return null
  }

  const failed = refresh?.status === 'failed'
  const isDismissed =
    !failed &&
    refresh?.status === 'pending' &&
    dismissedAt != null &&
    dismissedAt === refresh.last_detected_at

  if (isDismissed) {
    return null
  }

  const kindsLabel = formatRuntimeRefreshChangeKinds(refresh?.change_kinds ?? [])

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-3 border-b px-4 py-2.5 text-[13px]',
        failed
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-border/60 bg-paper text-ink-2',
      )}
      data-testid="runtime-refresh-workspace-banner"
    >
      <AlertCircle
        className={cn('h-4 w-4 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {failed
            ? t('workspace.runtimeRefresh.failedTitle', 'Runtime refresh failed')
            : t(
                'workspace.runtimeRefresh.pendingTitle',
                'Workspace configuration updated',
              )}
        </p>
        <p className="text-[12px] text-muted-foreground">
          {failed
            ? (refresh?.last_error ??
              t(
                'workspace.runtimeRefresh.failedGeneric',
                'Could not read the updated workspace configuration.',
              ))
            : kindsLabel
              ? t('workspace.runtimeRefresh.pendingKinds', 'Updated: {{kinds}}', { kinds: kindsLabel })
              : t(
                  'workspace.runtimeRefresh.pendingBody',
                  'Running sessions keep their current configuration; the latest configuration loads the next time their runtime starts.',
                )}
          {!failed && kindsLabel
            ? ` ${t(
                'workspace.runtimeRefresh.pendingBody',
                'Running sessions keep their current configuration; the latest configuration loads the next time their runtime starts.',
              )}`
            : null}
        </p>
      </div>
      {!failed && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-[12px] text-muted-foreground"
          onClick={() => dismissBanner()}
          data-testid="runtime-refresh-dismiss"
        >
          <X className="h-3.5 w-3.5" />
          {t('workspace.runtimeRefresh.dismiss', 'Got it')}
        </Button>
      )}
    </div>
  )
}
