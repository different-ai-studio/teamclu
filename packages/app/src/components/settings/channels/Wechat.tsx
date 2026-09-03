import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Bot,
  ArrowRight,
  ArrowLeft,
  Zap,
  Shield,
  Smartphone,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { appDisplayName } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useChannelsStore,
  type WeChatConfig,
  defaultWeChatConfig,
} from '@/stores/channels'
import { WeChatIcon } from './shared'
import { GatewayStatusCard } from './GatewayStatusCard'
import { useChannelConfig } from '@/hooks/useChannelConfig'
import { QRCodeSVG } from 'qrcode.react'
import { invoke } from '@tauri-apps/api/core'
import { useShallow } from 'zustand/react/shallow'

// WeChat Setup Wizard Steps
const WECHAT_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.wechat.wizardIntroTitle',
    title: 'Welcome to WeChat Setup',
    descKey: 'settings.channels.wechat.wizardIntroDesc',
    description: `Let's connect your WeChat account to ${appDisplayName} via ClawBot.`,
  },
  {
    id: 'scan',
    titleKey: 'settings.channels.wechat.wizardScanTitle',
    title: 'Scan QR Code',
    descKey: 'settings.channels.wechat.wizardScanDesc',
    description: 'Scan the QR code with WeChat on your iPhone to log in.',
  },
  {
    id: 'verify',
    titleKey: 'settings.channels.wechat.wizardVerifyTitle',
    title: 'Login Confirmed',
    descKey: 'settings.channels.wechat.wizardVerifyDesc',
    description: 'Your WeChat account has been successfully connected.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.wechat.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.wechat.wizardCompleteDesc',
    description: 'Your WeChat bot is ready to use.',
  },
]

interface QrData {
  qrcode: string
  qrcodeImgContent?: string
}

interface QrStatusResponse {
  status: 'scaned' | 'confirmed' | 'expired' | 'wait'
  botToken?: string
  ilinkBotId?: string
  baseurl?: string
}

function WeChatSetupWizard({
  open,
  onOpenChange,
  onLoginSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLoginSuccess: (data: { botToken: string; accountId: string; baseUrl: string }) => void
}) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState(0)
  const [qrData, setQrData] = React.useState<QrData | null>(null)
  const [qrLoading, setQrLoading] = React.useState(false)
  const [scanStatus, setScanStatus] = React.useState<string>('')
  const [error, setError] = React.useState<string>('')
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setQrData(null)
      setQrLoading(false)
      setScanStatus('')
      setError('')
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [open])

  const fetchQrCode = async () => {
    setQrLoading(true)
    setError('')
    setScanStatus('')
    try {
      const data = await invoke<QrData>('start_wechat_qr_login')
      setQrData(data)
      setQrLoading(false)

      // Start polling for scan status
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const status = await invoke<QrStatusResponse>('poll_wechat_qr_status', { qrcode: data.qrcode })
          setScanStatus(status.status)
          if (status.status === 'confirmed') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            onLoginSuccess({
              botToken: status.botToken || '',
              accountId: status.ilinkBotId || '',
              baseUrl: status.baseurl || 'https://ilinkai.weixin.qq.com',
            })
            setStep(2) // advance to verify
          } else if (status.status === 'expired') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setError('QR code expired. Please try again.')
          }
        } catch (e) {
          console.error('[WeChat] Poll error:', e)
        }
      }, 1500)
    } catch (e) {
      setQrLoading(false)
      setError(String(e))
    }
  }

  const handleClose = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    onOpenChange(false)
  }

  const currentStep = WECHAT_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-green-100 to-emerald-100 dark:from-green-900/50 dark:to-emerald-900/50">
                  <Bot className="h-16 w-16 text-green-600 dark:text-green-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-green-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.wechat.connectTitle', { defaultValue: 'Connect WeChat to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.wechat.connectDesc', "This wizard will connect your WeChat account via ClawBot. You'll scan a QR code with WeChat on your iPhone to log in.")}
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-green-100 dark:bg-green-900/50 p-2">
                  <Zap className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.quickSetup', 'Quick Setup')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.wechat.quickSetupDesc', 'Scan and connect in under a minute')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-2">
                  <Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.wechat.iosRequired', 'iPhone Required')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.wechat.iosRequiredDesc', 'WeChat on iOS is required for QR code login')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-2">
                  <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.wechat.secure', 'Secure Connection')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.wechat.secureDesc', 'Credentials stored locally, never sent to our servers')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'scan':
        return (
          <div className="space-y-4">
            {!qrData && !qrLoading && (
              <div className="text-center space-y-4">
                <p className="text-[13px] text-muted-foreground">
                  {t('settings.channels.wechat.clickToGetQr', 'Click below to generate a QR code for WeChat login.')}
                </p>
                <Button onClick={fetchQrCode} className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t('settings.channels.wechat.getQrCode', 'Get QR Code')}
                </Button>
              </div>
            )}

            {qrLoading && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-green-500" />
                <p className="text-[13px] text-muted-foreground">{t('settings.channels.wechat.loadingQr', 'Generating QR code...')}</p>
              </div>
            )}

            {qrData && !qrLoading && (
              <div className="flex flex-col items-center space-y-4">
                <div className="p-4 bg-white rounded-xl shadow-sm border">
                  <QRCodeSVG value={qrData.qrcodeImgContent || qrData.qrcode} size={200} level="M" />
                </div>
                <p className="text-[13px] text-muted-foreground text-center">
                  {t('settings.channels.wechat.scanInstructions', 'Open WeChat on your iPhone and scan this QR code to log in.')}
                </p>
                {scanStatus === 'scaned' && (
                  <div className="flex items-center gap-2 text-[13px] text-amber-600 dark:text-amber-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.channels.wechat.waitingConfirm', 'QR scanned — please confirm on your phone...')}
                  </div>
                )}
                {scanStatus === 'wait' && (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.channels.wechat.waitingScan', 'Waiting for scan...')}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-[13px] text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span className="flex-1">{error}</span>
                <Button variant="ghost" size="sm" onClick={fetchQrCode} className="gap-1">
                  <RefreshCw className="h-3 w-3" />
                  {t('settings.channels.wechat.retry', 'Retry')}
                </Button>
              </div>
            )}
          </div>
        )

      case 'verify':
        return (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-6">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.wechat.loginSuccess', 'Login Successful!')}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.wechat.loginSuccessDesc', 'Your WeChat account has been connected to ClawBot.')}
              </p>
            </div>
          </div>
        )

      case 'complete':
        return (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-6">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.allSet', "You're all set!")}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.wechat.completeMessage', 'Your WeChat connection is configured. Click "Finish" to save your settings and start using it.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-[13px] font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-[13px] text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.wechat.nextStepMessage', 'Send a message in WeChat to test the connection!')}</li>
              </ul>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-green-500" />
            {t(currentStep.titleKey, currentStep.title)}
          </DialogTitle>
          <DialogDescription>
            {t(currentStep.descKey, currentStep.description)}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        <div className="flex items-center gap-1 py-2">
          {WECHAT_WIZARD_STEPS.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                "flex-1 h-1.5 rounded-full transition-colors",
                i <= step ? "bg-green-500" : "bg-muted"
              )}
            />
          ))}
        </div>

        <div className="py-4 min-h-[300px] overflow-hidden">
          {renderStepContent()}
        </div>

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          {step === 0 && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                {t('settings.channels.cancel', 'Cancel')}
              </Button>
              <div className="flex-1" />
              <Button onClick={() => setStep(1)} className="gap-1">
                {t('settings.channels.next', 'Next')}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}
          {step === 1 && (
            <>
              <Button variant="outline" onClick={() => setStep(0)} className="gap-1">
                <ArrowLeft className="h-4 w-4" />
                {t('settings.channels.back', 'Back')}
              </Button>
              <div className="flex-1" />
            </>
          )}
          {step === 2 && (
            <>
              <div className="flex-1" />
              <Button onClick={() => setStep(3)} className="gap-1">
                {t('settings.channels.next', 'Next')}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <div className="flex-1" />
              <Button onClick={handleClose} className="gap-2">
                <Sparkles className="h-4 w-4" />
                {t('settings.channels.finishSetup', 'Finish Setup')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WeChatChannel() {
  const { t } = useTranslation()
  const {
    wechat,
    wechatIsLoading,
    wechatGatewayStatus,
    wechatHasChanges,
    loadWechatConfig,
    saveWechatConfig,
    startWechatGateway,
    stopWechatGateway,
    refreshWechatStatus,
    setWechatHasChanges,
    toggleWechatEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ wechat: s.wechat, wechatIsLoading: s.wechatIsLoading, wechatGatewayStatus: s.wechatGatewayStatus, wechatHasChanges: s.wechatHasChanges, loadWechatConfig: s.loadWechatConfig, saveWechatConfig: s.saveWechatConfig, startWechatGateway: s.startWechatGateway, stopWechatGateway: s.stopWechatGateway, refreshWechatStatus: s.refreshWechatStatus, setWechatHasChanges: s.setWechatHasChanges, toggleWechatEnabled: s.toggleWechatEnabled })),
  )

  const [expanded, setExpanded] = React.useState(false)
  const [wizardOpen, setWizardOpen] = React.useState(false)

  React.useEffect(() => {
    loadWechatConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    isSaving,
    handleSave,
    handleRestart,
  } = useChannelConfig<WeChatConfig>({
    storeConfig: wechat,
    defaultConfig: defaultWeChatConfig,
    gatewayStatus: wechatGatewayStatus,
    isLoading: wechatIsLoading,
    hasChanges: wechatHasChanges,
    setHasChanges: setWechatHasChanges,
    saveConfig: saveWechatConfig,
    startGateway: startWechatGateway,
    stopGateway: stopWechatGateway,
    refreshStatus: refreshWechatStatus,
  })

  const handleLoginSuccess = (data: { botToken: string; accountId: string; baseUrl: string }) => {
    updateLocalConfig({
      botToken: data.botToken,
      accountId: data.accountId,
      baseUrl: data.baseUrl,
      enabled: true,
    })
    setWechatHasChanges(true)
  }

  const isAuthError = wechatGatewayStatus.errorMessage?.toLowerCase().includes('auth') ||
    wechatGatewayStatus.errorMessage?.toLowerCase().includes('token') ||
    wechatGatewayStatus.errorMessage?.toLowerCase().includes('login')

  return (
    <>
      <GatewayStatusCard
        icon={
          <div className="rounded-md p-1.5 bg-green-100 dark:bg-green-900/50">
            <WeChatIcon className="h-4 w-4" />
          </div>
        }
        title={t('settings.channels.wechat.gateway', 'WeChat Gateway')}
        status={wechatGatewayStatus.status}
        statusDetail={
          wechatGatewayStatus.accountId ? (
            <p className="text-xs text-muted-foreground">
              Account: {wechatGatewayStatus.accountId}
            </p>
          ) : localConfig.accountId ? (
            <p className="text-[13px] text-muted-foreground">
              Account: {localConfig.accountId}
            </p>
          ) : undefined
        }
        errorMessage={wechatGatewayStatus.errorMessage}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(!expanded)}
        enabled={localConfig.enabled}
        onToggleEnabled={(enabled) => {
          updateLocalConfig({ enabled })
          toggleWechatEnabled(enabled, { ...localConfig, enabled })
        }}
        isLoading={wechatIsLoading}
        isConnecting={isConnecting}
        isRunning={isRunning}
        hasChanges={wechatHasChanges}
        onStart={startWechatGateway}
        onStop={stopWechatGateway}
        onRestart={handleRestart}
        startDisabled={!localConfig.botToken}
        onOpenWizard={() => setWizardOpen(true)}
      >
        {/* Setup Wizard Prompt - Show when no token */}
        {!localConfig.botToken && (
          <div className="p-4 rounded-lg bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border border-green-200 dark:border-green-800">
            <div className="flex items-center gap-4">
              <Bot className="h-8 w-8 text-green-600 dark:text-green-400 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-green-900 dark:text-green-100">
                  {t('settings.channels.wechat.setupTitle', 'Set up WeChat Integration')}
                </h4>
                <p className="text-[13px] text-green-700 dark:text-green-300 mt-1">
                  {t('settings.channels.wechat.setupDesc', 'Connect your WeChat account by scanning a QR code.')}
                </p>
              </div>
              <Button onClick={() => setWizardOpen(true)} size="sm" className="gap-2 flex-shrink-0">
                <Sparkles className="h-4 w-4" />
                {t('settings.channels.startSetup', 'Start Setup')}
              </Button>
            </div>
          </div>
        )}

        {/* Account Info when configured */}
        {localConfig.botToken && (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-[13px] font-medium flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t('settings.channels.wechat.connectionInfo', 'Connection Info')}
              </label>
              <div className="p-3 rounded-lg bg-muted/50 space-y-1">
                {localConfig.accountId && (
                  <p className="text-[13px]">
                    <span className="text-muted-foreground">{t('settings.channels.wechat.accountId', 'Account ID')}:</span>{' '}
                    <span className="font-mono text-xs">{localConfig.accountId}</span>
                  </p>
                )}
                <p className="text-[13px]">
                  <span className="text-muted-foreground">{t('settings.channels.wechat.baseUrl', 'Base URL')}:</span>{' '}
                  <span className="font-mono text-xs">{localConfig.baseUrl}</span>
                </p>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" />
                {t('settings.channels.credentialsStoredLocally', 'Your credentials are stored locally and never sent to our servers.')}
              </p>
            </div>

            {/* Re-login button for auth errors */}
            {isAuthError && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-[13px] font-medium text-amber-900 dark:text-amber-100">
                      {t('settings.channels.wechat.authExpired', 'Login session expired')}
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t('settings.channels.wechat.authExpiredDesc', 'Please scan the QR code again to re-login.')}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setWizardOpen(true)} className="gap-1 flex-shrink-0">
                    <RefreshCw className="h-3 w-3" />
                    {t('settings.channels.wechat.reLogin', 'Re-login')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error message */}
        {wechatGatewayStatus.errorMessage && !isAuthError && (
          <div className="flex items-center gap-2 text-[13px] text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {wechatGatewayStatus.errorMessage}
          </div>
        )}

        {/* Save Button */}
        <Button
          className="w-full gap-2"
          onClick={handleSave}
          disabled={wechatIsLoading || isSaving}
        >
          {wechatIsLoading || isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.channels.saving', 'Saving...')}
            </>
          ) : (
            t('settings.channels.saveChanges', 'Save Changes')
          )}
        </Button>
      </GatewayStatusCard>

      {/* WeChat Setup Wizard */}
      <WeChatSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onLoginSuccess={handleLoginSuccess}
      />
    </>
  )
}
