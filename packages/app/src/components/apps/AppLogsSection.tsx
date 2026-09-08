import { useTranslation } from 'react-i18next'
import { ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openAppLogs } from '@/lib/tabs/app-tabs'
import type { AppRow } from '@/lib/backend/types'

interface AppLogsSectionProps {
  app: AppRow
}

/**
 * Entry point to the logs tab, in the control panel.
 *
 * Costs no request: whether logs can exist at all is already on the app row
 * (`fcStatus`), and everything else — how far back, which stream, what to
 * search for — belongs to the tab, which has room for it. A section that
 * previewed the last few lines here would fetch on every app selection to show
 * text nobody can read in a 280px column.
 */
export function AppLogsSection({ app }: AppLogsSectionProps) {
  const { t } = useTranslation()
  const deployed = Boolean(app.fcStatus) && app.fcStatus !== 'not_deployed'

  if (!deployed) {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-logs-state-not-deployed">
        {t('apps.logs.notDeployed', '这个应用还没有部署过，部署之后才会有日志。')}
      </p>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
        {t('apps.logs.hint', '应用打印的内容与每次请求')}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1.5 rounded-[7px] px-2.5 text-[11.5px]"
        data-testid="app-logs-open"
        onClick={() => openAppLogs(app, t('apps.logs.tabLabel', '日志'))}
      >
        <ScrollText className="h-3 w-3" />
        {t('apps.logs.open', '查看日志')}
      </Button>
    </div>
  )
}
