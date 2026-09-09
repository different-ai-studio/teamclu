import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { getBackend } from '@/lib/backend'
import { AppTabShell } from './AppTabShell'
import { AppFilesSection } from './AppFilesSection'
import type { AppRow } from '@/lib/backend/types'

/**
 * The app's files, with room for the list.
 *
 * The section component is reused rather than reimplemented: it already knows
 * about signed uploads, the stale usage number and the per-app `canWrite` the
 * server returns, and a second copy of that would drift. What the tab adds is
 * width — a file list in a 280px column truncated every path to uselessness.
 */
export function AppFilesTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell
      appId={appId}
      title={t('apps.files.tabTitle', '应用附件')}
      description={t(
        'apps.files.tabDescription',
        '上传的文件，以及应用自己运行时写入的文件。删除应用不会删掉它们。',
      )}
    >
      {(app) => <FilesBody app={app} />}
    </AppTabShell>
  )
}

function FilesBody({ app }: { app: AppRow }) {
  // `admin` on this app is what may purge; upload and delete are decided by the
  // server's own `canWrite`, inside the section. Reading the grant list is the
  // same permission as holding `admin`, so its success IS the answer.
  const [canManage, setCanManage] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const grants = await getBackend().apps.listAppAccess(app.id)
        if (!cancelled) setCanManage(grants !== null)
      } catch {
        if (!cancelled) setCanManage(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app.id])

  return <AppFilesSection app={app} canManage={canManage} />
}
