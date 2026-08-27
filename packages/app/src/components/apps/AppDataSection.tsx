import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getBackend } from '@/lib/backend'
import { AppDataBrowserDialog } from './AppDataBrowserDialog'
import type { AppDataTablesResult, AppRow } from '@/lib/backend/types'

interface AppDataSectionProps {
  app: AppRow
  /** `admin` on this app. `prompt` may browse but not edit (design §6). */
  canEdit: boolean
}

/**
 * Entry point for browsing the app's live data.
 *
 * The table itself opens in a dialog rather than inline: the control panel is a
 * 288px column and a row of database columns does not fit in it. What stays
 * here is the part that is genuinely narrow — which state the app is in, and
 * the list of table names.
 */
export function AppDataSection({ app, canEdit }: AppDataSectionProps) {
  const { t } = useTranslation()
  const [result, setResult] = React.useState<AppDataTablesResult | null | 'loading'>('loading')
  const [browsing, setBrowsing] = React.useState<string | null>(null)

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

  // Re-read once a deploy lands: before the first one there is no database at
  // all, so the section would otherwise stay on "not deployed" until a reload.
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

  // Null means the caller cannot see this app's data at all (`view` tier or a
  // non-member) — the feature is not theirs to know about.
  if (result === null) return null

  // Each of these is a different situation, so each gets its own sentence. A
  // shared "no data" would make a normal state read as a fault.
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
        {/* Not an error: the provisioner creates the schema, the application
            creates its tables the first time someone requests it. */}
        {t('apps.data.noTables', '还没有表 —— 应用首次被访问时创建。')}
      </p>
    )
  }

  return (
    <>
      <ul className="space-y-1">
        {result.tables.map((table) => (
          <li key={table.name} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">
              {table.name}
              {!table.editable && (
                <span className="ml-1.5 text-[10px] text-faint">
                  {t('apps.data.readOnlyBadge', '只读')}
                </span>
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 shrink-0 gap-1 rounded-[6px] px-2 text-[11px]"
              data-testid={`app-data-open-${table.name}`}
              onClick={() => setBrowsing(table.name)}
            >
              <Database className="h-3 w-3" />
              {t('apps.data.browse', '查看')}
            </Button>
          </li>
        ))}
      </ul>

      <AppDataBrowserDialog
        open={browsing !== null}
        onOpenChange={(o) => !o && setBrowsing(null)}
        app={app}
        tables={result.tables}
        canEdit={canEdit}
        initialTable={browsing}
      />
    </>
  )
}
