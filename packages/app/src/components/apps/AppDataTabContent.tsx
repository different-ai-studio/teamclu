import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import { decodeAppDataTarget } from '@/lib/tabs/app-tabs'
import { AppDataBrowser } from './AppDataBrowser'
import type { AppDataTable } from '@/lib/backend/types'

interface AppDataTabContentProps {
  target: string
}

export function AppDataTabContent({ target }: AppDataTabContentProps) {
  const { t } = useTranslation()
  const decoded = decodeAppDataTarget(target)
  const app = useAppsStore((s) =>
    decoded ? s.items.find((a) => a.id === decoded.appId) ?? null : null,
  )
  const [tables, setTables] = React.useState<AppDataTable[] | null | 'loading'>('loading')
  // Why there are no tables, when there are none. The control panel now shows
  // only a count, so this tab is the one place the reason is explained — and
  // "no database" and "not deployed yet" call for different next steps.
  const [reason, setReason] = React.useState<'no_database' | 'not_deployed' | 'unavailable' | null>(
    null,
  )
  const [reasonDetail, setReasonDetail] = React.useState<string | null>(null)
  const [canEdit, setCanEdit] = React.useState(false)

  React.useEffect(() => {
    if (!decoded || !app) {
      setTables(null)
      return
    }
    let cancelled = false
    setTables('loading')
    void (async () => {
      try {
        const [grants, listed] = await Promise.all([
          getBackend().apps.listAppAccess(app.id),
          getBackend().apps.listAppDataTables(app.id),
        ])
        if (cancelled) return
        setCanEdit(grants !== null)
        if (listed === null) {
          setTables(null)
          return
        }
        if (listed.status === 'ok') {
          setReason(null)
          setTables(listed.tables)
        } else {
          setReason(listed.status)
          setReasonDetail(listed.status === 'unavailable' ? listed.reason : null)
          setTables([])
        }
      } catch {
        if (!cancelled) setTables(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app?.id, decoded?.appId])

  if (!decoded) {
    return (
      <p className="p-6 text-[13px] text-muted-foreground">
        {t('apps.data.invalidTarget', '无效的数据表地址')}
      </p>
    )
  }

  if (!app) {
    return (
      <p className="p-6 text-[13px] text-muted-foreground">
        {t('apps.data.appNotFound', '找不到这个应用')}
      </p>
    )
  }

  if (tables === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  if (!tables || tables.length === 0) {
    return (
      <p className="p-6 text-[13px] text-muted-foreground" data-testid="app-data-tab-reason">
        {reason === 'no_database'
          ? t('apps.data.noDatabase', '这个类型的应用没有数据库。')
          : reason === 'not_deployed'
            ? t('apps.data.notDeployed', '首次部署后就能在这里查看线上数据。')
            : reason === 'unavailable'
              ? t('apps.data.unavailable', '暂时无法访问这个应用的数据库：{{reason}}', {
                  reason: reasonDetail ?? '',
                })
              : t('apps.data.noTables', '还没有表 —— 应用首次被访问时创建。')}
      </p>
    )
  }

  return (
    <AppDataBrowser
      app={app}
      tables={tables}
      canEdit={canEdit}
      initialTable={decoded.table}
    />
  )
}
