import { useTranslation } from 'react-i18next'
import { AppTabShell } from './AppTabShell'
import { AppSettingsPanel } from './AppSettingsPanel'

export function AppSettingsTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell appId={appId} title={t('apps.controlPanel.settings', '应用设置')}>
      {(app) => <AppSettingsPanel key={app.id} app={app} />}
    </AppTabShell>
  )
}
