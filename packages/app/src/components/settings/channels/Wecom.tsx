import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Bot,
  ArrowRight,
  ArrowLeft,
  Zap,
  ScanQrCode,
  Copy,
  MessageSquare,
  Users,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { cn } from '@/lib/utils'
import { appDisplayName } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useChannelsStore } from '@/stores/channels-store'
import { type WeComConfig, type WeComBot, defaultWeComConfig } from '@/stores/channels-types'
import { WeComIcon } from './shared'
import { GatewayStatusCard } from './GatewayStatusCard'
import { useChannelConfig } from '@/hooks/use-channel-config'
import { useCurrentTeamStore } from '@/stores/current-team'
import { botSecretPath, loadChannelSecretKeys } from '@/lib/channel-secret-presence'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
  type DaemonWorkspace,
} from '@/lib/daemon-workspaces'
import { useShallow } from 'zustand/react/shallow'

// WeCom Setup Wizard
const WECOM_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.wecom.wizardIntroTitle',
    title: 'Welcome to WeCom Setup',
    descKey: 'settings.channels.wecom.wizardIntroDesc',
    description: `Let's connect your WeCom AI bot to ${appDisplayName} in a few simple steps.`,
  },
  {
    id: 'choose-method',
    titleKey: 'settings.channels.wecom.chooseMethod',
    title: 'Choose Setup Method',
    descKey: 'settings.channels.wecom.chooseMethodDesc',
    description: 'How would you like to set up your WeCom bot?',
  },
  {
    id: 'qr-scan',
    titleKey: 'settings.channels.wecom.scanTitle',
    title: 'Scan QR Code',
    descKey: 'settings.channels.wecom.scanDesc',
    description: 'Use WeCom to scan the QR code below.',
  },
  {
    id: 'get-credentials',
    titleKey: 'settings.channels.wecom.wizardCredentialsTitle',
    title: 'Get Your Bot Credentials',
    descKey: 'settings.channels.wecom.wizardCredentialsDesc',
    description: 'Copy your Bot ID and Secret.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.wecom.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.wecom.wizardCompleteDesc',
    description: 'Your WeCom bot is ready to use.',
  },
]

function WeComSetupWizard({
  open,
  onOpenChange,
  onCredentialsSave,
  existingBotId,
  existingSecret,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSave: (botId: string, secret: string) => void
  existingBotId?: string
  existingSecret?: string
}) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState(0)
  const [botId, setBotId] = React.useState(existingBotId || '')
  const [secret, setSecret] = React.useState(existingSecret || '')
  const [method, setMethod] = React.useState<'qr' | 'manual' | null>(null)
  const [qrAuthUrl, setQrAuthUrl] = React.useState<string | null>(null)
  const [, setQrScode] = React.useState<string | null>(null)
  const [qrLoading, setQrLoading] = React.useState(false)
  const [qrError, setQrError] = React.useState<string>('')
  const [scanStatus, setScanStatus] = React.useState<string>('')
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const errorCountRef = React.useRef(0)

  const { startWecomQrAuth, pollWecomQrAuth } = useChannelsStore(
    useShallow((s) => ({ startWecomQrAuth: s.startWecomQrAuth, pollWecomQrAuth: s.pollWecomQrAuth })),
  )

  const cleanupPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    errorCountRef.current = 0
  }

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setBotId(existingBotId || '')
      setSecret(existingSecret || '')
      setMethod(null)
      setQrAuthUrl(null)
      setQrScode(null)
      setQrLoading(false)
      setQrError('')
      setScanStatus('')
      cleanupPolling()
    }
    return () => cleanupPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const fetchQrCode = async () => {
    setQrLoading(true)
    setQrError('')
    setScanStatus('')
    cleanupPolling()
    try {
      const data = await startWecomQrAuth()
      setQrAuthUrl(data.auth_url)
      setQrScode(data.scode)
      setQrLoading(false)

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const result = await pollWecomQrAuth(data.scode)
          errorCountRef.current = 0
          if (result.status === 'success' && result.botId && result.secret) {
            cleanupPolling()
            setScanStatus('success')
            setBotId(result.botId)
            setSecret(result.secret)
            // Advance to complete step — credentials saved on "Finish"
            setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'complete'))
          }
        } catch {
          errorCountRef.current++
          if (errorCountRef.current >= 3) {
            cleanupPolling()
            setQrError(t('settings.channels.wecom.scanError', 'Failed to get QR code. Please try again or use manual input.'))
          }
        }
      }, 3000)

      // Auto-expire after 5 minutes
      setTimeout(() => {
        if (pollRef.current) {
          cleanupPolling()
          setQrError(t('settings.channels.wecom.scanTimeout', 'QR code expired. Please try again.'))
          setQrAuthUrl(null)
        }
      }, 300000)
    } catch (e) {
      setQrLoading(false)
      setQrError(String(e))
    }
  }

  const handleNext = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'choose-method') {
      if (method === 'qr') {
        const qrStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'qr-scan')
        setStep(qrStep)
        // Auto-fetch QR code when entering scan step
        setTimeout(() => fetchQrCode(), 100)
      } else {
        const manualStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials')
        setStep(manualStep)
      }
    } else if (step < WECOM_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'qr-scan' || currentId === 'get-credentials') {
      cleanupPolling()
      setQrAuthUrl(null)
      setQrError('')
      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'choose-method'))
    } else if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleClose = () => {
    cleanupPolling()
    onOpenChange(false)
  }

  const handleComplete = () => {
    if (botId.trim() && secret.trim()) {
      onCredentialsSave(botId.trim(), secret.trim())
    }
    onOpenChange(false)
  }

  const currentStep = WECOM_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/50 dark:to-cyan-900/50">
                  <Bot className="h-16 w-16 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.wecom.connectTitle', { defaultValue: 'Connect WeCom to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.wecom.connectDesc', { defaultValue: "This wizard will guide you through creating a WeCom AI bot and connecting it to {{appName}}. You'll be able to interact with AI directly from WeCom chats.", appName: appDisplayName })}
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-blue-100 dark:bg-blue-900/50 p-2">
                  <Zap className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.quickSetup', 'Quick Setup')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.quickSetupDesc', 'Complete in about 5 minutes')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-2">
                  <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.wecom.longConnection', 'Long Connection')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.wecom.longConnectionDesc', 'No public server needed, runs locally via WebSocket')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'choose-method':
        return (
          <div className="space-y-4">
            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'qr'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('qr')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-blue-100 dark:bg-blue-900/50">
                  <ScanQrCode className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{t('settings.channels.wecom.qrScan', 'QR Code Scan')}</p>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
                      {t('settings.channels.wecom.qrScanRecommended', 'Recommended')}
                    </span>
                  </div>
                  <p className="text-[13px] text-muted-foreground">{t('settings.channels.wecom.qrScanDesc', 'Scan with WeCom to auto-create bot')}</p>
                </div>
              </div>
            </div>

            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'manual'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('manual')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-muted">
                  <Key className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">{t('settings.channels.wecom.manualInput', 'Manual Input')}</p>
                  <p className="text-[13px] text-muted-foreground">{t('settings.channels.wecom.manualInputDesc', 'Already have Bot ID and Secret')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'qr-scan':
        return (
          <div className="space-y-4">
            {!qrAuthUrl && !qrLoading && !qrError && (
              <div className="text-center space-y-4">
                <p className="text-[13px] text-muted-foreground">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                <Button onClick={fetchQrCode} className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t('settings.channels.wecom.getQrCode', 'Get QR Code')}
                </Button>
              </div>
            )}

            {qrLoading && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                <p className="text-[13px] text-muted-foreground">{t('settings.channels.wecom.loadingQr', 'Generating QR code...')}</p>
              </div>
            )}

            {qrAuthUrl && !qrLoading && (
              <div className="flex flex-col items-center space-y-4">
                <div className="p-4 bg-white rounded-xl shadow-sm border">
                  <QRCodeSVG value={qrAuthUrl} size={200} level="M" />
                </div>
                <p className="text-[13px] text-muted-foreground text-center">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                {scanStatus !== 'success' && (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.channels.wecom.waitingScan', 'Waiting for scan...')}
                  </div>
                )}
                {scanStatus === 'success' && (
                  <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    {t('settings.channels.wecom.scanSuccess', 'Authorization successful! Credentials obtained.')}
                  </div>
                )}
              </div>
            )}

            {qrError && (
              <div className="text-center space-y-3">
                <div className="flex items-center justify-center gap-2 text-[13px] text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {qrError}
                </div>
                <div className="flex justify-center gap-2">
                  <Button variant="outline" onClick={fetchQrCode} size="sm" className="gap-1">
                    {t('settings.channels.wecom.retryQr', 'Retry')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMethod('manual')
                      setQrError('')
                      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials'))
                    }}
                  >
                    {t('settings.channels.wecom.switchToManual', 'Switch to Manual Input')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )

      case 'get-credentials':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div className="text-[13px]">
                  <p className="font-medium text-amber-900 dark:text-amber-100">{t('settings.channels.wecom.credentialsSecretWarning', 'Keep your credentials secret!')}</p>
                  <p className="text-amber-800 dark:text-amber-200">
                    {t('settings.channels.wecom.credentialsSecretDesc', 'Never share your Bot Secret. It is stored locally on your device.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.wecom.credentialsPortalHint', 'In the WeCom Admin Console, go to your AI Bot settings:')}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.wecom.botId', 'Bot ID')}</label>
              <Input
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
                placeholder={t('settings.channels.wecom.botIdPlaceholder', 'Enter your WeCom bot ID')}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.wecom.secret', 'Secret')}</label>
              <div className="relative">
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t('settings.channels.wecom.secretPlaceholder', 'Enter your WeCom bot secret')}
                  className="pr-10"
                />
                <Key className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {botId && secret && (
              <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {t('settings.channels.wecom.credentialsEntered', 'Credentials entered')}
              </div>
            )}
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
                {t('settings.channels.wecom.completeMessage', 'Your WeCom bot is now configured. Click "Finish" to save your settings and start using the bot.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-[13px] font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-[13px] text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.wecom.nextStepMessage', 'Send a message to your bot in WeCom to test!')}</li>
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
            <Sparkles className="h-5 w-5 text-blue-500" />
            {t(currentStep.titleKey, currentStep.title)}
          </DialogTitle>
          <DialogDescription>
            {t(currentStep.descKey, { defaultValue: currentStep.description, appName: appDisplayName })}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        <div className="flex items-center gap-1 py-2">
          {WECOM_WIZARD_STEPS.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                "flex-1 h-1.5 rounded-full transition-colors",
                i <= step ? "bg-blue-500" : "bg-muted"
              )}
            />
          ))}
        </div>

        <div className="py-4 min-h-[300px] overflow-hidden">
          {renderStepContent()}
        </div>

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          {step > 0 && step < WECOM_WIZARD_STEPS.length - 1 && (
            <Button variant="outline" onClick={handleBack} className="gap-1">
              <ArrowLeft className="h-4 w-4" />
              {t('settings.channels.back', 'Back')}
            </Button>
          )}
          <div className="flex-1" />
          {step === 0 && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('settings.channels.cancel', 'Cancel')}
            </Button>
          )}
          {step < WECOM_WIZARD_STEPS.length - 1 ? (
            <Button
              onClick={handleNext}
              className="gap-1"
              disabled={
                (WECOM_WIZARD_STEPS[step]?.id === 'choose-method' && !method) ||
                (WECOM_WIZARD_STEPS[step]?.id === 'get-credentials' && (!botId || !secret)) ||
                WECOM_WIZARD_STEPS[step]?.id === 'qr-scan'
              }
            >
              {t('settings.channels.next', 'Next')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleComplete} className="gap-2">
              <Sparkles className="h-4 w-4" />
              {t('settings.channels.finishSetup', 'Finish Setup')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WeComChannel() {
  const { t } = useTranslation()
  const {
    wecom,
    wecomIsLoading,
    wecomGatewayStatus,
    wecomHasChanges,
    loadWecomConfig,
    saveWecomConfig,
    startWecomGateway,
    stopWecomGateway,
    refreshWecomStatus,
    setWecomHasChanges,
    toggleWecomEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ wecom: s.wecom, wecomIsLoading: s.wecomIsLoading, wecomGatewayStatus: s.wecomGatewayStatus, wecomHasChanges: s.wecomHasChanges, loadWecomConfig: s.loadWecomConfig, saveWecomConfig: s.saveWecomConfig, startWecomGateway: s.startWecomGateway, stopWecomGateway: s.stopWecomGateway, refreshWecomStatus: s.refreshWecomStatus, setWecomHasChanges: s.setWecomHasChanges, toggleWecomEnabled: s.toggleWecomEnabled })),
  )
  const botStatuses = useChannelsStore(s => s.wecomBotStatuses)
  const loadWecomBotStatuses = useChannelsStore(s => s.loadWecomBotStatuses)
  const team = useCurrentTeamStore(s => s.team)

  const [expanded, setExpanded] = React.useState(false)
  const [wizardOpen, setWizardOpen] = React.useState(false)
  const [workspaceOptions, setWorkspaceOptions] = React.useState<DaemonWorkspace[]>([])

  React.useEffect(() => {
    loadWecomConfig()
    loadWecomBotStatuses()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load available daemon workspaces for the per-bot workspace picker. Same source
  // as DaemonWorkspacesSection (public.workspaces via the current daemon agent).
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!team?.id) {
        if (!cancelled) setWorkspaceOptions([])
        return
      }
      try {
        const agent = await getCurrentDaemonWorkspaceAgent(team.id)
        const list = agent ? await listDaemonWorkspaces(team.id, agent.id) : []
        if (!cancelled) setWorkspaceOptions(list.filter(w => !w.archived))
      } catch {
        if (!cancelled) setWorkspaceOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [team?.id])

  const {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    isSaving,
    handleSave,
    handleRestart,
  } = useChannelConfig<WeComConfig>({
    storeConfig: wecom,
    defaultConfig: defaultWeComConfig,
    gatewayStatus: wecomGatewayStatus,
    isLoading: wecomIsLoading,
    hasChanges: wecomHasChanges,
    setHasChanges: setWecomHasChanges,
    saveConfig: saveWecomConfig,
    startGateway: startWecomGateway,
    stopGateway: stopWecomGateway,
    refreshStatus: refreshWecomStatus,
  })

  const bots = localConfig.bots ?? []

  // Which credential boxes already hold a value. They read back empty by
  // design, so without this an unset key and a stored one look identical —
  // and the safe-looking move (retype it) is the one that can break a working
  // gateway.
  const [storedSecrets, setStoredSecrets] = React.useState<Set<string>>(new Set())
  React.useEffect(() => {
    let cancelled = false
    void loadChannelSecretKeys().then((keys) => {
      if (!cancelled) setStoredSecrets(keys)
    })
    return () => {
      cancelled = true
    }
  }, [wecomIsLoading])
  const storedHint = (botId: string, field: string) =>
    botId && storedSecrets.has(botSecretPath('wecom', botId, field))
      ? t('settings.channels.secretStored', 'Configured · leave empty to keep')
      : null

  const updateBot = (i: number, patch: Partial<WeComBot>) => {
    updateLocalConfig({ bots: bots.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
    setWecomHasChanges(true)
  }
  const addBot = () => {
    updateLocalConfig({ bots: [...bots, { enabled: true, botId: '', secret: '' }] })
    setWecomHasChanges(true)
  }
  const removeBot = (i: number) => {
    updateLocalConfig({ bots: bots.filter((_, j) => j !== i) })
    setWecomHasChanges(true)
  }

  const startDisabled = bots.length === 0 || bots.some(b => !b.botId || !b.secret)

  const handleWizardSave = (botId: string, secret: string) => {
    updateLocalConfig({ bots: [...bots, { enabled: true, botId, secret }], enabled: true })
    setWecomHasChanges(true)
  }

  return (
    <>
      <GatewayStatusCard
        icon={
          <div className="rounded-md p-1.5 bg-blue-100 dark:bg-blue-900/50">
            <WeComIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
        }
        title={t('settings.channels.wecom.gateway', 'WeCom Gateway')}
        status={wecomGatewayStatus.status}
        statusDetail={
          wecomGatewayStatus.botId ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Bot: {wecomGatewayStatus.botId}
              </p>
              {wecomGatewayStatus.activeSessions && wecomGatewayStatus.activeSessions.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {wecomGatewayStatus.activeSessions.length} active session{wecomGatewayStatus.activeSessions.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          ) : undefined
        }
        errorMessage={wecomGatewayStatus.errorMessage}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(!expanded)}
        enabled={localConfig.enabled}
        onToggleEnabled={(enabled) => {
          updateLocalConfig({ enabled })
          toggleWecomEnabled(enabled, { ...localConfig, enabled })
        }}
        isLoading={wecomIsLoading}
        isConnecting={isConnecting}
        isRunning={isRunning}
        hasChanges={wecomHasChanges}
        onStart={startWecomGateway}
        onStop={stopWecomGateway}
        onRestart={handleRestart}
        startDisabled={startDisabled}
        onOpenWizard={() => setWizardOpen(true)}
      >
        {/* Setup Wizard Prompt - Show when no bots configured */}
        {bots.length === 0 && (
          <div className="p-4 rounded-lg bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-950/30 dark:to-cyan-950/30 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-4">
              <Bot className="h-8 w-8 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-blue-900 dark:text-blue-100">
                  {t('settings.channels.wecom.setupTitle', 'Set up WeCom Integration')}
                </h4>
                <p className="text-[13px] text-blue-700 dark:text-blue-300 mt-1">
                  {t('settings.channels.wecom.setupDesc', 'Connect a WeCom AI bot to interact with AI from WeCom chats.')}
                </p>
              </div>
              <Button onClick={() => setWizardOpen(true)} size="sm" className="gap-2 flex-shrink-0">
                <Sparkles className="h-4 w-4" />
                {t('settings.channels.startSetup', 'Start Setup')}
              </Button>
            </div>
          </div>
        )}

        {/* Per-bot list */}
        <div className="space-y-3">
          {bots.map((bot, i) => {
            const status = botStatuses.find(s => s.botId === bot.botId)
            return (
              <div
                key={i}
                className="space-y-3 rounded-lg border border-border-soft bg-background/50 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[13px] font-medium flex items-center gap-2">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    {t('settings.channels.wecom.botLabel', { defaultValue: 'Bot {{n}}', n: i + 1 })}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => removeBot(i)}
                  >
                    {t('settings.channels.wecom.removeBot', 'Remove')}
                  </Button>
                </div>

                {/* Per-bot connection status */}
                {bot.botId && (
                  status?.connected ? (
                    <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t('settings.channels.wecom.botConnected', 'Connected')}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AlertCircle className="h-3.5 w-3.5" />
                      {t('settings.channels.wecom.botDisconnected', 'Disconnected')}
                      {status?.error ? <span className="text-red-600">— {status.error}</span> : null}
                    </div>
                  )
                )}

                {/* Bot ID */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.botId', 'Bot ID')}</label>
                  <Input
                    value={bot.botId}
                    onChange={e => updateBot(i, { botId: e.target.value })}
                    placeholder={t('settings.channels.wecom.botIdPlaceholder', 'Enter your WeCom bot ID')}
                  />
                </div>

                {/* Secret */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.secret', 'Secret')}</label>
                  <div className="relative">
                    <Input
                      type="password"
                      value={bot.secret}
                      onChange={e => updateBot(i, { secret: e.target.value })}
                      placeholder={
                        storedHint(bot.botId, 'secret')
                          ? '••••••••••••'
                          : t('settings.channels.wecom.secretPlaceholder', 'Enter your WeCom bot secret')
                      }
                      className="pr-10"
                    />
                    <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  </div>
                </div>

                {/* Encoding AES Key (optional) */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('settings.channels.wecom.encodingAesKey', 'Encoding AES Key')}{' '}
                    <span className="font-normal">({t('settings.channels.optional', 'optional')})</span>
                  </label>
                  <Input
                    type="password"
                    value={bot.encodingAesKey || ''}
                    onChange={e => updateBot(i, { encodingAesKey: e.target.value || undefined })}
                    placeholder={
                      storedHint(bot.botId, 'encoding_aes_key')
                        ? '••••••••••••'
                        : t('settings.channels.wecom.encodingAesKeyPlaceholder', '43-character key for attachment decryption')
                    }
                  />
                  {storedHint(bot.botId, 'encoding_aes_key') && (
                    <p className="text-[11px] text-muted-foreground">{storedHint(bot.botId, 'encoding_aes_key')}</p>
                  )}
                </div>

                {/* Bot display name (optional) */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('settings.channels.wecom.botName', 'Bot name')}{' '}
                    <span className="font-normal">({t('settings.channels.optional', 'optional')})</span>
                  </label>
                  <Input
                    value={bot.botName || ''}
                    onChange={e => updateBot(i, { botName: e.target.value || undefined })}
                    placeholder={t('settings.channels.wecom.botNamePlaceholder', 'Exact name in WeCom, e.g. Matt chow的机器人 1')}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t('settings.channels.wecom.botNameHint', 'Group messages arrive as "@name text" — the exact name is what strips the mention back off.')}
                  </p>
                </div>

                {/* MCP api key (optional) */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t('settings.channels.wecom.apiKey', 'MCP API Key')}{' '}
                    <span className="font-normal">({t('settings.channels.optional', 'optional')})</span>
                  </label>
                  <Input
                    type="password"
                    value={bot.apiKey || ''}
                    onChange={e => updateBot(i, { apiKey: e.target.value || undefined })}
                    placeholder={
                      storedHint(bot.botId, 'api_key')
                        ? '••••••••••••'
                        : t('settings.channels.wecom.apiKeyPlaceholder', 'apikey from the bot\u2019s 消息 authorization page')
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {storedHint(bot.botId, 'api_key') ??
                      t('settings.channels.wecom.apiKeyHint', 'Lets a scheduled task pick a chat from this bot\u2019s conversation list.')}
                  </p>
                </div>

                {/* Workspace */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.botWorkspace', 'Workspace')}</label>
                  {workspaceOptions.length > 0 ? (
                    <select
                      value={bot.workspaceId ?? ''}
                      onChange={e => updateBot(i, { workspaceId: e.target.value || undefined })}
                      className="h-9 w-full rounded-[7px] border border-border bg-paper px-3 text-[13px] transition-colors focus:border-foreground/30 focus:outline-none"
                    >
                      <option value="">{t('settings.channels.wecom.botDefaultOption', 'Default')}</option>
                      {workspaceOptions.map(w => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={bot.workspaceId ?? ''}
                      onChange={e => updateBot(i, { workspaceId: e.target.value || undefined })}
                      placeholder={t('settings.channels.wecom.botDefaultOption', 'Default')}
                    />
                  )}
                </div>

                {/* System prompt */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.botSystemPrompt', 'System prompt')}</label>
                  <textarea
                    value={bot.systemPrompt ?? ''}
                    onChange={e => updateBot(i, { systemPrompt: e.target.value || undefined })}
                    placeholder={t('settings.channels.wecom.botSystemPromptPlaceholder', 'Optional system prompt for this bot')}
                    rows={3}
                    className="w-full rounded-[7px] border border-border bg-paper px-3 py-2 text-[13px] transition-colors focus:border-foreground/30 focus:outline-none"
                  />
                </div>
              </div>
            )
          })}

          <Button variant="outline" size="sm" className="gap-1.5" onClick={addBot}>
            <Bot className="h-4 w-4" />
            {t('settings.channels.wecom.addBot', 'Add bot')}
          </Button>

          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Shield className="h-3 w-3" />
            {t('settings.channels.credentialsStoredLocally', 'Your credentials are stored locally and never sent to our servers.')}
          </p>
        </div>

        {/* Active Sessions */}
        {wecomGatewayStatus.activeSessions && wecomGatewayStatus.activeSessions.length > 0 && (
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              {t('settings.channels.wecom.activeSessions', 'Active Sessions')}
              <span className="text-xs text-muted-foreground font-normal">({wecomGatewayStatus.activeSessions.length})</span>
            </label>
            <div className="space-y-1">
              {wecomGatewayStatus.activeSessions.map((sessionKey) => {
                const isDm = sessionKey.startsWith('wecom:dm:')
                const chatId = isDm ? sessionKey.replace('wecom:dm:', '') : sessionKey.replace('wecom:', '')
                return (
                  <div
                    key={sessionKey}
                    className="flex items-center gap-2 p-2 rounded-md bg-muted/50 text-[13px] group"
                  >
                    {isDm ? (
                      <MessageSquare className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                    ) : (
                      <Users className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                    )}
                    <span className="text-xs text-muted-foreground">{isDm ? 'DM' : 'Group'}</span>
                    <code className="text-xs font-mono flex-1 truncate">{chatId}</code>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
                      onClick={() => navigator.clipboard.writeText(chatId)}
                      title={t('settings.channels.wecom.copyChatId', 'Copy Chat ID')}
                    >
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Error message */}
        {wecomGatewayStatus.errorMessage && (
          <div className="flex items-center gap-2 text-[13px] text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {wecomGatewayStatus.errorMessage}
          </div>
        )}

        {/* Save Button */}
        <Button
          className="w-full gap-2"
          onClick={handleSave}
          disabled={wecomIsLoading || isSaving}
        >
          {wecomIsLoading || isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.channels.saving', 'Saving...')}
            </>
          ) : (
            t('settings.channels.saveChanges', 'Save Changes')
          )}
        </Button>
      </GatewayStatusCard>

      {/* WeCom Setup Wizard */}
      <WeComSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCredentialsSave={handleWizardSave}
      />
    </>
  )
}
