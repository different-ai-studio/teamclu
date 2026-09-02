import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getBackend } from '@/lib/backend'
import { openAppDataTable } from '@/lib/tabs/app-tabs'
import type { AppDataTablesResult, AppRow } from '@/lib/backend/types'

interface AppDataSectionProps {
  app: AppRow
  /** `admin` on this app. `prompt` may browse but not edit (design §6). */
  canEdit: boolean
}

/**
 * Lists live tables in the control panel; opening one launches a main-column tab.
 */
export function AppDataSection({ app, canEdit: _canEdit }: AppDataSectionProps) {
  const { t } = useTranslation()
  const [result, setResult] = React.useState<AppDataTablesResult | null | 'loading'>('loading')

  const load = React.useCallback(async () => {
    setResult('loading')
    try {
      setResult(await getBackend().apps.listAppDataTables(app.id))
    } catch (e) {
      console.error('[AppDataSection] failed to list tables', e)
      setResult({ status: 'unavailable', reason: e instanceof Error ? e.message : String(e) })
    }
  }, [app.id])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (app.fcStatus === 'live') void load()
  }, [app.fcStatus, load])

  if (result === 'loading') {
    return (
      <div className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  if (result === null) return null

  if (result.status === 'no_database') {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-data-state-no-database">
        {t('apps.data.noDatabase', '这个类型的应用没有数据库。')}
      </p>
    )
  }
  if (result.status === 'not_deployed') {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-data-state-not-deployed">
        {t('apps.data.notDeployed', '首次部署后就能在这里查看线上数据。')}
      </p>
    )
  }
  if (result.status === 'unavailable') {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-data-state-unavailable">
        {t('apps.data.unavailable', '暂时无法访问这个应用的数据库：{{reason}}', {
          reason: result.reason,
        })}
      </p>
    )
  }
  if (result.tables.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground" data-testid="app-data-state-no-tables">
        {t('apps.data.noTables', '还没有表 —— 应用首次被访问时创建。')}
      </p>
    )
  }

  // One entry, not a table list. The browser this opens has its own table
  // switcher, so repeating every name here only made the panel long — and the
  // count is the part worth seeing at a glance.
  const first = result.tables[0]
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
        {t('apps.data.tableCount', '{{count}} 张表', { count: result.tables.length })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1.5 rounded-[7px] px-2.5 text-[11.5px]"
        data-testid="app-data-open"
        onClick={() => openAppDataTable(app, first.name)}
      >
        <Database className="h-3 w-3" />
        {t('apps.data.open', '打开数据')}
      </Button>
    </div>
  )
}
