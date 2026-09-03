import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Shield,
  CheckCircle2,
  Sparkles,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Zap,
  Globe,
  MessageSquare,
  ExternalLink,
} from 'lucide-react'
import { cn, openExternalUrl } from '@/lib/utils'
import { appDisplayName } from '@/lib/config/build-config'
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
import { type EmailConfig } from '@/stores/channels-types'
import { GmailIcon } from './shared'

// Email Setup Wizard Steps
const EMAIL_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.email.wizardIntroTitle',
    title: 'Welcome to Email Setup',
    descKey: 'settings.channels.email.wizardIntroDesc',
    description: `Let's connect your email to ${appDisplayName} as a communication channel.`,
  },
  {
    id: 'provider',
    titleKey: 'settings.channels.email.wizardProviderTitle',
    title: 'Choose Provider',
    descKey: 'settings.channels.email.wizardProviderDesc',
    description: 'Select your email provider.',
  },
  {
    id: 'credentials',
    titleKey: 'settings.channels.email.wizardCredentialsTitle',
    title: 'Configure Credentials',
    descKey: 'settings.channels.email.wizardCredentialsDesc',
    description: 'Set up authentication for your email account.',
  },
  {
    id: 'filters',
    titleKey: 'settings.channels.email.wizardFiltersTitle',
    title: 'Configure Filters',
    descKey: 'settings.channels.email.wizardFiltersDesc',
    description: 'Set up which emails the bot should respond to.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.email.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.email.wizardCompleteDesc',
    description: 'Your email gateway is ready to use.',
  },
]

export function EmailSetupWizard({
  open,
  onOpenChange,
  onConfigSave,
  existingConfig,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfigSave: (config: Partial<EmailConfig>) => void
  existingConfig?: EmailConfig
}) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState(0)
  const [provider, setProvider] = React.useState<'gmail' | 'custom'>(existingConfig?.provider || 'gmail')
  const [gmailClientId, setGmailClientId] = React.useState(existingConfig?.gmailClientId || '')
  const [gmailClientSecret, setGmailClientSecret] = React.useState(existingConfig?.gmailClientSecret || '')
  const [gmailEmail, setGmailEmail] = React.useState(existingConfig?.gmailEmail || '')
  const [imapServer, setImapServer] = React.useState(existingConfig?.imapServer || '')
  const [imapPort, setImapPort] = React.useState(existingConfig?.imapPort || 993)
  const [smtpServer, setSmtpServer] = React.useState(existingConfig?.smtpServer || '')
  const [smtpPort, setSmtpPort] = React.useState(existingConfig?.smtpPort || 587)
  const [username, setUsername] = React.useState(existingConfig?.username || '')
  const [password, setPassword] = React.useState(existingConfig?.password || '')

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setProvider(existingConfig?.provider || 'gmail')
      setGmailClientId(existingConfig?.gmailClientId || '')
      setGmailClientSecret(existingConfig?.gmailClientSecret || '')
      setGmailEmail(existingConfig?.gmailEmail || '')
      setImapServer(existingConfig?.imapServer || '')
      setImapPort(existingConfig?.imapPort || 993)
      setSmtpServer(existingConfig?.smtpServer || '')
      setSmtpPort(existingConfig?.smtpPort || 587)
      setUsername(existingConfig?.username || '')
      setPassword(existingConfig?.password || '')
    }
  }, [open, existingConfig])

  const handleNext = () => {
    if (step < EMAIL_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleComplete = () => {
    if (provider === 'gmail') {
      onConfigSave({
        provider: 'gmail',
        gmailClientId,
        gmailClientSecret,
        gmailEmail,
      })
    } else {
      onConfigSave({
        provider: 'custom',
        imapServer,
        imapPort,
        smtpServer,
        smtpPort,
        username,
        password,
      })
    }
    onOpenChange(false)
  }

  const currentStep = EMAIL_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/50 dark:to-orange-900/50">
                  <GmailIcon className="h-16 w-16 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.email.connectTitle', { defaultValue: 'Connect Email to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.email.connectDesc', 'This wizard will guide you through setting up email as a communication channel. The bot will monitor your inbox, process incoming emails through AI, and send threaded replies.')}
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-amber-100 dark:bg-amber-900/50 p-2">
                  <Zap className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.email.realtimeMonitoring', 'Real-time Monitoring')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.email.realtimeMonitoringDesc', 'Uses IMAP IDLE for near-instant email detection')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-2">
                  <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.email.senderFiltering', 'Sender Filtering')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.email.senderFilteringDesc', 'Control which emails get AI responses')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-blue-100 dark:bg-blue-900/50 p-2">
                  <MessageSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.channels.email.threadedReplies', 'Threaded Replies')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.email.threadedRepliesDesc', 'Maintains email conversation threads automatically')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'provider':
        return (
          <div className="space-y-6">
            <div className="grid gap-3">
              <button
                className={cn(
                  'flex items-start gap-4 p-4 rounded-lg border transition-all text-left',
                  provider === 'gmail'
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                    : 'border-muted hover:border-muted-foreground/30'
                )}
                onClick={() => setProvider('gmail')}
              >
                <div className="rounded-lg p-2 bg-red-100 dark:bg-red-900/50">
                  <GmailIcon className="h-5 w-5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold">{t('settings.channels.email.gmailOAuth', 'Gmail (OAuth2)')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('settings.channels.email.gmailOAuthDesc', 'Secure OAuth2 authentication. Requires a Google Cloud project with Gmail API enabled. Best for Gmail accounts with 2FA.')}
                  </p>
                </div>
              </button>

              <button
                className={cn(
                  'flex items-start gap-4 p-4 rounded-lg border transition-all text-left',
                  provider === 'custom'
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                    : 'border-muted hover:border-muted-foreground/30'
                )}
                onClick={() => setProvider('custom')}
              >
                <div className="rounded-lg p-2 bg-blue-100 dark:bg-blue-900/50">
                  <Globe className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold">{t('settings.channels.email.imapSmtp', 'Custom IMAP/SMTP')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('settings.channels.email.imapSmtpDesc', 'Works with any email provider (Outlook, Yahoo, QQ, etc.). Uses standard username/password or app password authentication.')}
                  </p>
                </div>
              </button>
            </div>
          </div>
        )

      case 'credentials':
        if (provider === 'gmail') {
          return (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <p className="text-[13px] font-medium text-blue-800 dark:text-blue-200">{t('settings.channels.email.gmailOAuthSetup', 'Gmail OAuth2 Setup')}</p>
                <ol className="text-xs text-blue-700 dark:text-blue-300 mt-2 space-y-1 list-decimal ml-4">
                  <li>{t('settings.channels.email.gmailStep1', 'Go to')} <button className="underline" onClick={() => openExternalUrl('https://console.cloud.google.com/')}>Google Cloud Console</button></li>
                  <li>{t('settings.channels.email.gmailStep2', 'Create a new project (or select existing)')}</li>
                  <li>{t('settings.channels.email.gmailStep3', 'Enable the Gmail API')}</li>
                  <li>{t('settings.channels.email.gmailStep4', 'Go to APIs & Services > Credentials')}</li>
                  <li>{t('settings.channels.email.gmailStep5', 'Create OAuth client ID (type: Desktop application)')}</li>
                  <li>{t('settings.channels.email.gmailStep6', 'Copy the Client ID and Client Secret below')}</li>
                </ol>
              </div>
              <div>
                <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.clientId', 'Client ID')}</label>
                <Input
                  placeholder="your-client-id.apps.googleusercontent.com"
                  value={gmailClientId}
                  onChange={(e) => setGmailClientId(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.clientSecret', 'Client Secret')}</label>
                <Input
                  type="password"
                  placeholder="GOCSPX-..."
                  value={gmailClientSecret}
                  onChange={(e) => setGmailClientSecret(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.gmailAddress', 'Gmail Address')}</label>
                <Input
                  type="email"
                  placeholder="your-email@gmail.com"
                  value={gmailEmail}
                  onChange={(e) => setGmailEmail(e.target.value)}
                />
              </div>
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('settings.channels.email.gmailOAuthNote', 'Note: After saving, you will need to click "Authorize with Google" in the Email Gateway panel to complete the OAuth2 flow. This will open your browser for Google consent.')}
                </p>
              </div>
            </div>
          )
        } else {
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.imapServer', 'IMAP Server')}</label>
                  <Input
                    placeholder="imap.example.com"
                    value={imapServer}
                    onChange={(e) => setImapServer(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.imapPort', 'IMAP Port')}</label>
                  <Input
                    type="number"
                    placeholder="993"
                    value={imapPort}
                    onChange={(e) => setImapPort(parseInt(e.target.value) || 993)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.smtpServer', 'SMTP Server')}</label>
                  <Input
                    placeholder="smtp.example.com"
                    value={smtpServer}
                    onChange={(e) => setSmtpServer(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.smtpPort', 'SMTP Port')}</label>
                  <Input
                    type="number"
                    placeholder="587"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(parseInt(e.target.value) || 587)}
                  />
                </div>
              </div>
              <div>
                <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.username', 'Username (email address)')}</label>
                <Input
                  placeholder="your-email@example.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.password', 'Password / App Password')}</label>
                <Input
                  type="password"
                  placeholder={t('settings.channels.email.passwordPlaceholder', 'Enter your password or app password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
          )
        }

      case 'filters':
        return (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('settings.channels.email.filtersIntro', 'You can configure sender filters and labels later in the Email Gateway settings panel. By default, the bot will reply to all new emails.')}
            </p>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-[13px] font-medium">{t('settings.channels.email.defaultSettings', 'Default Settings')}</p>
              <ul className="text-xs text-muted-foreground mt-2 space-y-1 list-disc ml-4">
                <li>{t('settings.channels.email.defaultReply', 'Reply to all new emails: Enabled')}</li>
                <li>{t('settings.channels.email.defaultSenderFilter', 'Sender filter: None (accepts all senders)')}</li>
                <li>{t('settings.channels.email.defaultThreading', 'Email threading: Automatic')}</li>
              </ul>
            </div>
          </div>
        )

      case 'complete':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-4">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
              </div>
            </div>
            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.allSet', "You're all set!")}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.email.completeMessage', 'Your email gateway configuration has been saved.')}
                {provider === 'gmail' && (
                  <> {t('settings.channels.email.gmailAuthReminder', 'Don\'t forget to click "Authorize with Google" to complete the OAuth2 setup.')}</>
                )}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50 text-center">
              <p className="text-[13px]">{t('settings.channels.email.clickFinish', 'Click "Finish Setup" to save and close.')}</p>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t(currentStep.titleKey, currentStep.title)}</DialogTitle>
          <DialogDescription>{t(currentStep.descKey, currentStep.description)}</DialogDescription>
        </DialogHeader>

        {/* Progress */}
        <div className="flex gap-1 mb-2">
          {EMAIL_WIZARD_STEPS.map((_, idx) => (
            <div
              key={idx}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                idx <= step ? 'bg-amber-500' : 'bg-muted'
              )}
            />
          ))}
        </div>

        {renderStepContent()}

        <DialogFooter className="flex justify-between">
          {step > 0 && step < EMAIL_WIZARD_STEPS.length - 1 && (
            <Button variant="outline" onClick={handleBack} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('settings.channels.back', 'Back')}
            </Button>
          )}
          <div className="flex-1" />
          {step < EMAIL_WIZARD_STEPS.length - 1 ? (
            <Button onClick={handleNext} className="gap-2">
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

// Re-export for convenience
export { BookOpen, ExternalLink }
