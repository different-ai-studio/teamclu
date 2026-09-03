import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Shield } from 'lucide-react'
import { useTelemetryStore } from '@/stores/telemetry'
import { cn } from '@/lib/utils'
import { appDisplayName } from '@/lib/config/build-config'
import { ToggleSwitch } from './shared'

export function PrivacySection() {
  const { t } = useTranslation()
  const consent = useTelemetryStore((s) => s.consent)
  const setConsent = useTelemetryStore((s) => s.setConsent)

  const isGranted = consent === 'granted'

  const handleToggleConsent = React.useCallback(async (enabled: boolean) => {
    await setConsent(enabled ? 'granted' : 'denied')
  }, [setConsent])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="rounded-[14px] border border-border-soft bg-panel p-3">
          <Shield className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-[15px] font-semibold tracking-normal">
            {t('settings.privacy.title', 'Privacy & Telemetry')}
          </h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {t('settings.privacy.description', { defaultValue: 'Control anonymous usage data collection to help improve {{appName}}.', appName: appDisplayName })}
          </p>
        </div>
      </div>

      {/* Consent Toggle */}
      <div className="rounded-[14px] border border-border bg-paper p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold">{t('settings.privacy.analyticsTitle', 'Analytics Data Collection')}</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {t('settings.privacy.analyticsDesc', 'Store anonymous usage metrics locally (tokens, tool stats, scores). No code, conversations, or personal data. Data stays on your device.')}
            </p>
          </div>
          <ToggleSwitch enabled={isGranted} onChange={handleToggleConsent} />
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <div className={cn(
            'h-2 w-2 rounded-full',
            isGranted ? 'bg-green-500' : 'bg-muted-foreground/30',
          )} />
          {isGranted ? t('settings.privacy.analyticsEnabled', 'Analytics enabled') : t('settings.privacy.analyticsDisabled', 'Analytics disabled')}
        </div>
      </div>

    </div>
  )
}
