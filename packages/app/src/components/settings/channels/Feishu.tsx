import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  Hash,
  Plus,
  Trash2,
  Edit2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Check,
  Sparkles,
  Bot,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Zap,
} from 'lucide-react'
import { cn, openExternalUrl } from '@/lib/utils'
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
import {
  useChannelsStore,
  type FeishuConfig,
  type FeishuChatConfig,
  defaultFeishuConfig,
} from '@/stores/channels'
import { FeishuIcon, ToggleSwitch } from './shared'
import { GatewayStatusCard } from './GatewayStatusCard'
import { TestCredentialsButton } from './TestCredentialsButton'
import { useChannelConfig } from '@/hooks/useChannelConfig'
import { useShallow } from 'zustand/react/shallow'

// Feishu Setup Wizard
const FEISHU_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.feishu.wizardIntroTitle',
    title: 'Welcome to Feishu Setup',
    descKey: 'settings.channels.feishu.wizardIntroDesc',
    description: `Let's connect your Feishu bot to ${appDisplayName} in a few simple steps.`,
  },
  {
    id: 'create-app',
    titleKey: 'settings.channels.feishu.wizardCreateTitle',
    title: 'Create Feishu Application',
    descKey: 'settings.channels.feishu.wizardCreateDesc',
    description: 'Create an enterprise application in Feishu Developer Portal.',
  },
  {
    id: 'get-credentials',
    titleKey: 'settings.channels.feishu.wizardCredentialsTitle',
    title: 'Get Your App Credentials',
    descKey: 'settings.channels.feishu.wizardCredentialsDesc',
    description: 'Copy your App ID and App Secret.',
  },
  {
    id: 'permissions',
    titleKey: 'settings.channels.feishu.wizardPermissionsTitle',
    title: 'Configure Permissions & Events',
    descKey: 'settings.channels.feishu.wizardPermissionsDesc',
    description: 'Set up required permissions and event subscriptions.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.feishu.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.feishu.wizardCompleteDesc',
    description: 'Your Feishu bot is ready to use.',
  },
]

function FeishuSetupWizard({
  open,
  onOpenChange,
  onCredentialsSave,
  existingAppId,
  existingAppSecret,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSave: (appId: string, appSecret: string) => void
  existingAppId?: string
  existingAppSecret?: string
}) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState(0)
  const [appId, setAppId] = React.useState(existingAppId || '')
  const [appSecret, setAppSecret] = React.useState(existingAppSecret || '')

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setAppId(existingAppId || '')
      setAppSecret(existingAppSecret || '')
    }
  }, [open, existingAppId, existingAppSecret])

  const handleNext = () => {
    if (step < FEISHU_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleComplete = () => {
    if (appId.trim() && appSecret.trim()) {
      onCredentialsSave(appId.trim(), appSecret.trim())
    }
    onOpenChange(false)
  }

  const currentStep = FEISHU_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50">
                  <Bot className="h-16 w-16 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.feishu.connectTitle', { defaultValue: 'Connect Feishu to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.feishu.connectDesc', { defaultValue: "This wizard will guide you through creating a Feishu app and connecting it to {{appName}}. You'll be able to interact with AI directly from Feishu chats.", appName: appDisplayName })}
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
                  <p className="text-[13px] font-medium">{t('settings.channels.feishu.longConnection', 'Long Connection')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.feishu.longConnectionDesc', 'No public server needed, runs locally')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'create-app':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                <div className="space-y-2 text-[13px]">
                  <p className="font-medium text-blue-900 dark:text-blue-100">{t('settings.channels.feishu.createAppSteps', 'Steps to create your Feishu app')}:</p>
                  <ol className="list-decimal list-inside space-y-2 text-blue-800 dark:text-blue-200">
                    <li>{t('settings.channels.feishu.createAppStep1', 'Go to the Feishu Developer Portal')}</li>
                    <li>{t('settings.channels.feishu.createAppStep2', 'Click "Create Custom App"')}</li>
                    <li>{t('settings.channels.feishu.createAppStep3', { defaultValue: 'Enter a name (e.g., "{{appName}} Bot") and description', appName: appDisplayName })}</li>
                    <li>{t('settings.channels.feishu.createAppStep4', 'Select your organization')}</li>
                    <li>{t('settings.channels.feishu.createAppStep5', 'Click "Create"')}</li>
                  </ol>
                </div>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => openExternalUrl('https://open.feishu.cn/app')}
            >
              <ExternalLink className="h-4 w-4" />
              {t('settings.channels.feishu.openDeveloperPortal', 'Open Feishu Developer Portal')}
            </Button>
          </div>
        )

      case 'get-credentials':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div className="text-[13px]">
                  <p className="font-medium text-amber-900 dark:text-amber-100">{t('settings.channels.feishu.credentialsSecretWarning', 'Keep your credentials secret!')}</p>
                  <p className="text-amber-800 dark:text-amber-200">
                    {t('settings.channels.feishu.credentialsSecretDesc', 'Never share your App Secret. It is stored locally on your device.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.feishu.credentialsPortalHint', 'In the Feishu Developer Portal, go to "Credentials & Basic Info":')}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.feishu.appId', 'App ID')}</label>
              <Input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder={t('settings.channels.feishu.appIdPlaceholder', 'cli_xxxxxxxxxxxxxxxx')}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.feishu.appSecret', 'App Secret')}</label>
              <div className="relative">
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={t('settings.channels.feishu.appSecretPlaceholder', 'Your app secret')}
                  className="pr-10"
                />
                <Key className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {appId && appSecret && (
              <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {t('settings.channels.feishu.credentialsEntered', 'Credentials entered')}
              </div>
            )}
          </div>
        )

      case 'permissions':
        return (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('settings.channels.feishu.permissionsIntro', 'Configure the following in Feishu Developer Portal:')}
            </p>

            <div className="space-y-3">
              <h4 className="text-[13px] font-medium">{t('settings.channels.feishu.requiredPermissions', '1. Required Permissions')}</h4>
              <div className="space-y-2">
                {[
                  { name: 'im:message', desc: t('settings.channels.feishu.permReadMessages', 'Read messages') },
                  { name: 'im:message:send_as_bot', desc: t('settings.channels.feishu.permSendAsBot', 'Send messages as bot') },
                  { name: 'im:chat', desc: t('settings.channels.feishu.permAccessChat', 'Access chat information') },
                  { name: 'im:resource', desc: t('settings.channels.feishu.permAccessResource', 'Access message resources (images)') },
                ].map((perm) => (
                  <div key={perm.name} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                    <Check className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                    <div>
                      <p className="text-[13px] font-medium font-mono">{perm.name}</p>
                      <p className="text-xs text-muted-foreground">{perm.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-[13px] font-medium">{t('settings.channels.feishu.eventSubscription', '2. Event Subscription')}</h4>
              <div className="p-3 rounded-lg bg-muted/50 text-[13px] space-y-2">
                <p>{t('settings.channels.feishu.eventStep1', 'Go to "Events & Callbacks" → "Event Subscriptions"')}</p>
                <p>{t('settings.channels.feishu.eventStep2', 'Select "Use Long Connection to Receive Events" mode')}</p>
                <p>{t('settings.channels.feishu.eventStep3', 'Add event:')} <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">im.message.receive_v1</code></p>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-[13px] font-medium">{t('settings.channels.feishu.publish', '3. Publish')}</h4>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.feishu.publishDesc', 'Create a version and publish the app to make it available.')}
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
                {t('settings.channels.feishu.completeMessage', 'Your Feishu bot is now configured. Click "Finish" to save your settings and start using the bot.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-[13px] font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-[13px] text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.feishu.nextStepConfigure', 'Configure chat/group settings if needed')}</li>
                <li>• {t('settings.channels.nextStepTest', 'Send a message to your bot to test!')}</li>
              </ul>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-500" />
            {t(currentStep.titleKey, currentStep.title)}
          </DialogTitle>
          <DialogDescription>
            {t(currentStep.descKey, currentStep.description)}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        <div className="flex items-center gap-1 py-2">
          {FEISHU_WIZARD_STEPS.map((s, i) => (
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
          {step > 0 && step < FEISHU_WIZARD_STEPS.length - 1 && (
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
          {step < FEISHU_WIZARD_STEPS.length - 1 ? (
            <Button
              onClick={handleNext}
              className="gap-1"
              disabled={step === 2 && (!appId || !appSecret)}
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

// Feishu Chat Configuration Dialog
function FeishuChatConfigDialog({
  open,
  onOpenChange,
  chat,
  chatId,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat?: FeishuChatConfig
  chatId?: string
  onSave: (chatId: string, config: FeishuChatConfig) => void
}) {
  const { t } = useTranslation()
  const [id, setId] = React.useState(chatId || '')
  const [allow, setAllow] = React.useState(chat?.allow ?? true)
  const [users, setUsers] = React.useState(chat?.users?.join(', ') || '')

  React.useEffect(() => {
    if (open) {
      setId(chatId || '')
      setAllow(chat?.allow ?? true)
      setUsers(chat?.users?.join(', ') || '')
    }
  }, [open, chat, chatId])

  const handleSave = () => {
    if (!id.trim()) return
    const config: FeishuChatConfig = {
      allow,
      users: users.split(',').map(s => s.trim()).filter(Boolean),
    }
    onSave(id.trim(), config)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{chatId ? t('settings.channels.feishu.editChat', 'Edit Chat') : t('settings.channels.feishu.addChat', 'Add Chat')}</DialogTitle>
          <DialogDescription>
            {t('settings.channels.feishu.chatConfigDesc', 'Configure settings for a specific Feishu chat or group.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.feishu.chatId', 'Chat ID')}</label>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('settings.channels.feishu.chatIdPlaceholder', 'oc_xxxxxxxxxxxxxxxx or *')}
              disabled={!!chatId}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.feishu.chatIdHint', 'Use * as wildcard to match all chats')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-[13px] font-medium">{t('settings.channels.feishu.chatAllow', 'Allow')}</label>
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.feishu.chatAllowDesc', 'Allow bot responses in this chat')}
              </p>
            </div>
            <ToggleSwitch enabled={allow} onChange={setAllow} />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.allowedUsers', 'Allowed Users')} ({t('settings.channels.optional', 'optional')})</label>
            <Input
              value={users}
              onChange={(e) => setUsers(e.target.value)}
              placeholder="ou_xxxxx, ou_yyyyy, ..."
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.feishu.allowedUsersHint', 'Comma-separated Feishu Open IDs. Leave empty to allow all.')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('settings.channels.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!id.trim()}>
            {t('settings.channels.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function FeishuChannel() {
  const { t } = useTranslation()
  const {
    feishu,
    feishuIsLoading,
    feishuGatewayStatus,
    feishuHasChanges,
    feishuIsTesting,
    feishuTestResult,
    saveFeishuConfig,
    startFeishuGateway,
    stopFeishuGateway,
    refreshFeishuStatus,
    testFeishuCredentials,
    clearFeishuTestResult,
    setFeishuHasChanges,
    toggleFeishuEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ feishu: s.feishu, feishuIsLoading: s.feishuIsLoading, feishuGatewayStatus: s.feishuGatewayStatus, feishuHasChanges: s.feishuHasChanges, feishuIsTesting: s.feishuIsTesting, feishuTestResult: s.feishuTestResult, saveFeishuConfig: s.saveFeishuConfig, startFeishuGateway: s.startFeishuGateway, stopFeishuGateway: s.stopFeishuGateway, refreshFeishuStatus: s.refreshFeishuStatus, testFeishuCredentials: s.testFeishuCredentials, clearFeishuTestResult: s.clearFeishuTestResult, setFeishuHasChanges: s.setFeishuHasChanges, toggleFeishuEnabled: s.toggleFeishuEnabled })),
  )

  const [feishuExpanded, setFeishuExpanded] = React.useState(false)
  const [feishuWizardOpen, setFeishuWizardOpen] = React.useState(false)
  const [feishuChatDialogOpen, setFeishuChatDialogOpen] = React.useState(false)
  const [editingFeishuChat, setEditingFeishuChat] = React.useState<{ id: string; config: FeishuChatConfig } | null>(null)
  const [deleteFeishuChatConfirm, setDeleteFeishuChatConfirm] = React.useState<string | null>(null)

  const {
    localConfig: feishuLocalConfig,
    updateLocalConfig: updateFeishuLocalConfig,
    isConnecting: feishuIsConnecting,
    isRunning: feishuIsRunning,
    isSaving: feishuIsSaving,
    handleSave: handleFeishuSave,
    handleRestart: handleFeishuRestart,
  } = useChannelConfig<FeishuConfig>({
    storeConfig: feishu,
    defaultConfig: defaultFeishuConfig,
    gatewayStatus: feishuGatewayStatus,
    isLoading: feishuIsLoading,
    hasChanges: feishuHasChanges,
    setHasChanges: setFeishuHasChanges,
    saveConfig: saveFeishuConfig,
    startGateway: startFeishuGateway,
    stopGateway: stopFeishuGateway,
    refreshStatus: refreshFeishuStatus,
  })

  const handleFeishuTestCredentials = async () => {
    if (!feishuLocalConfig.appId || !feishuLocalConfig.appSecret) return
    await testFeishuCredentials(feishuLocalConfig.appId, feishuLocalConfig.appSecret)
  }

  const handleFeishuWizardSave = (appId: string, appSecret: string) => {
    updateFeishuLocalConfig({ appId, appSecret, enabled: true })
  }

  const handleAddFeishuChat = (chatId: string, config: FeishuChatConfig) => {
    updateFeishuLocalConfig({
      chats: { ...feishuLocalConfig.chats, [chatId]: config },
    })
  }

  const handleUpdateFeishuChat = (chatId: string, config: FeishuChatConfig) => {
    updateFeishuLocalConfig({
      chats: { ...feishuLocalConfig.chats, [chatId]: config },
    })
  }

  const handleDeleteFeishuChat = (chatId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [chatId]: _, ...rest } = feishuLocalConfig.chats
    updateFeishuLocalConfig({ chats: rest })
    setDeleteFeishuChatConfirm(null)
  }

  if (!feishu) return null

  return (
    <>
      <GatewayStatusCard
        icon={
          <div className="rounded-md p-1.5 bg-blue-100 dark:bg-blue-900/50">
            <FeishuIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
        }
        title={t('settings.channels.feishu.gateway', 'Feishu Gateway')}
        status={feishuGatewayStatus.status}
        statusDetail={
          feishuGatewayStatus.appId ? (
            <p className="text-xs text-muted-foreground">
              App: {feishuGatewayStatus.appId}
            </p>
          ) : undefined
        }
        errorMessage={feishuGatewayStatus.errorMessage}
        expanded={feishuExpanded}
        onToggleExpanded={() => setFeishuExpanded(!feishuExpanded)}
        enabled={feishuLocalConfig.enabled}
        onToggleEnabled={(enabled) => {
          updateFeishuLocalConfig({ enabled })
          toggleFeishuEnabled(enabled, { ...feishuLocalConfig, enabled })
        }}
        isLoading={feishuIsLoading}
        isConnecting={feishuIsConnecting}
        isRunning={feishuIsRunning}
        hasChanges={feishuHasChanges}
        onStart={startFeishuGateway}
        onStop={stopFeishuGateway}
        onRestart={handleFeishuRestart}
        startDisabled={!feishuLocalConfig.appId || !feishuLocalConfig.appSecret}
        onOpenWizard={() => setFeishuWizardOpen(true)}
      >
        {/* Setup Wizard Prompt - Show when no credentials */}
        {!feishuLocalConfig.appId && (
          <div className="p-4 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-4">
              <Bot className="h-8 w-8 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-blue-900 dark:text-blue-100">
                  {t('settings.channels.feishu.setupTitle', 'Set up Feishu Integration')}
                </h4>
                <p className="text-[13px] text-blue-700 dark:text-blue-300 mt-1">
                  {t('settings.channels.feishu.setupDesc', 'Connect a Feishu bot to interact with AI from Feishu chats.')}
                </p>
              </div>
              <Button onClick={() => setFeishuWizardOpen(true)} size="sm" className="gap-2 flex-shrink-0">
                <Sparkles className="h-4 w-4" />
                {t('settings.channels.startSetup', 'Start Setup')}
              </Button>
            </div>
          </div>
        )}

        {/* App Credentials */}
        <div className="space-y-2">
          <label className="text-[13px] font-medium flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            {t('settings.channels.feishu.appCredentials', 'App Credentials')}
          </label>
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('settings.channels.feishu.appId', 'App ID')}</label>
              <Input
                value={feishuLocalConfig.appId}
                onChange={(e) => updateFeishuLocalConfig({ appId: e.target.value })}
                placeholder={t('settings.channels.feishu.appIdPlaceholder', 'cli_xxxxxxxxxxxxxxxx')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('settings.channels.feishu.appSecret', 'App Secret')}</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="password"
                    value={feishuLocalConfig.appSecret}
                    onChange={(e) => updateFeishuLocalConfig({ appSecret: e.target.value })}
                    placeholder={t('settings.channels.feishu.appSecretPlaceholder', 'Your app secret')}
                    className="pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <TestCredentialsButton
                  onTest={handleFeishuTestCredentials}
                  isTesting={feishuIsTesting}
                  testResult={feishuTestResult}
                  onClearResult={clearFeishuTestResult}
                  disabled={!feishuLocalConfig.appId || !feishuLocalConfig.appSecret}
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Shield className="h-3 w-3" />
            {t('settings.channels.credentialsStoredLocally', 'Your credentials are stored locally and never sent to our servers.')}
          </p>
        </div>

            {/* Chat Settings */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-[13px] font-medium flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  {t('settings.channels.feishu.chatSettings', 'Chat Settings')}
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingFeishuChat(null)
                    setFeishuChatDialogOpen(true)
                  }}
                  className="gap-2 h-7 text-xs"
                >
                  <Plus className="h-3 w-3" />
                  {t('settings.channels.feishu.addChat', 'Add Chat')}
                </Button>
              </div>

              <div className="pl-6">
                {Object.keys(feishuLocalConfig.chats).length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Hash className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-[13px] font-medium">{t('settings.channels.feishu.noChats', 'No chats configured')}</p>
                    <p className="text-xs">{t('settings.channels.feishu.noChatsHint', 'All chats and groups will be allowed by default. Add specific chats to restrict access.')}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(feishuLocalConfig.chats).map(([chatId, chatConfig]) => (
                      <div
                        key={chatId}
                        className="flex items-center justify-between py-1.5 px-2 rounded bg-muted/30 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Hash className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          <span className="font-mono truncate">{chatId === '*' ? `* (${t('settings.channels.all', 'all')})` : chatId}</span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[10px] flex-shrink-0",
                            chatConfig.allow
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                              : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
                          )}>
                            {chatConfig.allow ? 'allow' : 'deny'}
                          </span>
                          {chatConfig.users.length > 0 && (
                            <span className="text-muted-foreground">
                              {chatConfig.users.length} user(s)
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => {
                              setEditingFeishuChat({ id: chatId, config: chatConfig })
                              setFeishuChatDialogOpen(true)
                            }}
                          >
                            <Edit2 className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            onClick={() => setDeleteFeishuChatConfirm(chatId)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

        {/* Save Button */}
        <Button
          className="w-full gap-2"
          onClick={handleFeishuSave}
          disabled={feishuIsLoading || feishuIsSaving}
        >
          {feishuIsLoading || feishuIsSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.channels.saving', 'Saving...')}
            </>
          ) : (
            t('settings.channels.saveChanges', 'Save Changes')
          )}
        </Button>
      </GatewayStatusCard>

      {/* Feishu Chat Config Dialog */}
      <FeishuChatConfigDialog
        open={feishuChatDialogOpen}
        onOpenChange={setFeishuChatDialogOpen}
        chat={editingFeishuChat?.config}
        chatId={editingFeishuChat?.id}
        onSave={editingFeishuChat ? handleUpdateFeishuChat : handleAddFeishuChat}
      />

      {/* Delete Feishu Chat Confirmation */}
      <Dialog open={!!deleteFeishuChatConfirm} onOpenChange={(open) => !open && setDeleteFeishuChatConfirm(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('settings.channels.delete', 'Delete')} {t('settings.channels.feishu.chatId', 'Chat')}</DialogTitle>
            <DialogDescription>
              {t('settings.channels.feishu.deleteChatConfirmWithId', 'Are you sure you want to remove "{{id}}" from the configuration?', { id: deleteFeishuChatConfirm || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFeishuChatConfirm(null)}>
              {t('settings.channels.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteFeishuChatConfirm && handleDeleteFeishuChat(deleteFeishuChatConfirm)}
            >
              {t('settings.channels.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feishu Setup Wizard */}
      <FeishuSetupWizard
        open={feishuWizardOpen}
        onOpenChange={setFeishuWizardOpen}
        onCredentialsSave={handleFeishuWizardSave}
        existingAppId={feishuLocalConfig.appId}
        existingAppSecret={feishuLocalConfig.appSecret}
      />
    </>
  )
}
