import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Shield, Eye, EyeOff } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { useTelemetryStore } from '@/stores/telemetry'
import { appDisplayName } from '@/lib/config/build-config'

interface TelemetryConsentDialogProps {
  open: boolean
  onComplete: () => void
}

export function TelemetryConsentDialog({
  open,
  onComplete,
}: TelemetryConsentDialogProps) {
  const { t } = useTranslation()
  const setConsent = useTelemetryStore((s) => s.setConsent)

  const handleGrant = React.useCallback(async () => {
    await setConsent('granted')
    onComplete()
  }, [setConsent, onComplete])

  const handleDeny = React.useCallback(async () => {
    await setConsent('denied')
    onComplete()
  }, [setConsent, onComplete])

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <BarChart3 className="h-6 w-6 text-primary" />
          </div>
          <AlertDialogTitle className="text-center">
            {t('telemetry.consent.title', { appName: appDisplayName })}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-center">
            {t('telemetry.consent.description', { appName: appDisplayName })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-start gap-3 text-sm">
            <Eye className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">{t('telemetry.consent.collectTitle')}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {t('telemetry.consent.collectDescription')}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm">
            <EyeOff className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">{t('telemetry.consent.neverCollectTitle')}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {t('telemetry.consent.neverCollectDescription')}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm">
            <Shield className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">{t('telemetry.consent.changeAnytimeTitle')}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {t('telemetry.consent.changeAnytimeDescription')}
              </p>
            </div>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDeny}>
            {t('telemetry.consent.deny')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleGrant}>
            {t('telemetry.consent.allow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
