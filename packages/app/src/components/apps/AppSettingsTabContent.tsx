import { useTranslation } from 'react-i18next'
import { AppTabShell } from './AppTabShell'
import { AppControlPanel } from './AppControlPanel'

export function AppSettingsTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell appId={appId} title={t('apps.controlPanel.settings', '应用设置')}>
      {(app) => (
        <div className="max-w-[640px]">
          <AppControlPanel key={app.id} app={app} settings />
        </div>
      )}
    </AppTabShell>
  )
}
