import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  Users,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Sparkles,
  BookOpen,
  Zap,
  Globe,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { useChannelsStore } from '@/stores/channels-store'
import { type EmailConfig, defaultEmailConfig } from '@/stores/channels-types'
import { GmailIcon, SettingCard, ToggleSwitch, StatusBadge } from './shared'
import { EmailSetupWizard } from './EmailSetupWizard'
import { useShallow } from 'zustand/react/shallow'

export function EmailChannel() {
  const { t } = useTranslation()
  const {
    email,
    emailIsLoading,
    emailGatewayStatus,
    emailHasChanges,
    emailIsTesting,
    emailTestResult,
    gmailAuthUrl,
    saveEmailConfig,
    startEmailGateway,
    stopEmailGateway,
    refreshEmailStatus,
    testEmailConnection,
    gmailAuthorize,
    setEmailHasChanges,
    toggleEmailEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ email: s.email, emailIsLoading: s.emailIsLoading, emailGatewayStatus: s.emailGatewayStatus, emailHasChanges: s.emailHasChanges, emailIsTesting: s.emailIsTesting, emailTestResult: s.emailTestResult, gmailAuthUrl: s.gmailAuthUrl, saveEmailConfig: s.saveEmailConfig, startEmailGateway: s.startEmailGateway, stopEmailGateway: s.stopEmailGateway, refreshEmailStatus: s.refreshEmailStatus, testEmailConnection: s.testEmailConnection, gmailAuthorize: s.gmailAuthorize, setEmailHasChanges: s.setEmailHasChanges, toggleEmailEnabled: s.toggleEmailEnabled })),
  )

  const [emailLocalConfig, setEmailLocalConfig] = React.useState<EmailConfig>(defaultEmailConfig)
  const [emailExpanded, setEmailExpanded] = React.useState(false)
  const [emailWizardOpen, setEmailWizardOpen] = React.useState(false)
  const [newSender, setNewSender] = React.useState('')
  const [newLabel, setNewLabel] = React.useState('')
  const [deleteSenderConfirm, setDeleteSenderConfirm] = React.useState<string | null>(null)

  // Sync Email local config with store
  React.useEffect(() => {
    if (email) {
      setEmailLocalConfig(email)
    }
  }, [email])

  // Refresh Email status periodically when connected
  React.useEffect(() => {
    if (emailGatewayStatus.status === 'connected' || emailGatewayStatus.status === 'connecting') {
      const interval = setInterval(refreshEmailStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [emailGatewayStatus.status, refreshEmailStatus])

  const updateEmailLocalConfig = (updates: Partial<EmailConfig>) => {
    setEmailLocalConfig(prev => ({ ...prev, ...updates }))
  }

  const handleEmailSave = async () => {
    try {
      await saveEmailConfig(emailLocalConfig)
      if (emailIsRunning) {
        setEmailHasChanges(true)
      }
    } catch {
      // Error is handled by the store
    }
  }

  const handleTestEmailConnection = async () => {
    await testEmailConnection(emailLocalConfig)
  }

  const handleGmailAuthorize = async () => {
    if (!emailLocalConfig.gmailClientId || !emailLocalConfig.gmailClientSecret || !emailLocalConfig.gmailEmail) return
    const success = await gmailAuthorize(
      emailLocalConfig.gmailClientId,
      emailLocalConfig.gmailClientSecret,
      emailLocalConfig.gmailEmail
    )
    if (success) {
      updateEmailLocalConfig({ gmailAuthorized: true })
    }
  }

  const handleEmailWizardSave = (config: Partial<EmailConfig>) => {
    setEmailLocalConfig(prev => ({ ...prev, ...config, enabled: true }))
  }

  const handleAddSender = () => {
    const sender = newSender.trim()
    if (!sender) return
    if (emailLocalConfig.allowedSenders.includes(sender)) return
    updateEmailLocalConfig({
      allowedSenders: [...emailLocalConfig.allowedSenders, sender],
    })
    setNewSender('')
  }

  const handleRemoveSender = (sender: string) => {
    updateEmailLocalConfig({
      allowedSenders: emailLocalConfig.allowedSenders.filter(s => s !== sender),
    })
    setDeleteSenderConfirm(null)
  }

  const handleAddLabel = () => {
    const label = newLabel.trim()
    if (!label) return
    if (emailLocalConfig.labels.includes(label)) return
    updateEmailLocalConfig({
      labels: [...emailLocalConfig.labels, label],
    })
    setNewLabel('')
  }

  const handleRemoveLabel = (label: string) => {
    updateEmailLocalConfig({
      labels: emailLocalConfig.labels.filter(l => l !== label),
    })
  }

  const emailIsConnecting = emailGatewayStatus.status === 'connecting'
  const emailIsRunning = emailGatewayStatus.status === 'connected' || emailIsConnecting

  if (!email) return null

  return (
    <>
      <SettingCard className="!p-3">
        {/* Header Row - always visible */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setEmailExpanded(!emailExpanded)}
            className="flex items-center gap-3 flex-1 text-left"
          >
            <div className="rounded-md p-1.5 bg-blue-100 dark:bg-blue-900/50">
              <GmailIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{t('settings.channels.email.gateway', 'Email Gateway')}</span>
                <StatusBadge status={emailGatewayStatus.status} />
              </div>
              {emailGatewayStatus.email && (
                <p className="text-xs text-muted-foreground">
                  {emailGatewayStatus.email}
                </p>
              )}
              {emailGatewayStatus.errorMessage && (
                <p className="text-xs text-red-500">{emailGatewayStatus.errorMessage}</p>
              )}
            </div>
            {emailExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEmailWizardOpen(true)}
              className="h-7 w-7 p-0"
              title={t('settings.channels.startSetup', 'Start Setup')}
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </Button>
            <ToggleSwitch
              enabled={emailLocalConfig.enabled}
              onChange={async (enabled) => {
                updateEmailLocalConfig({ enabled })
                await toggleEmailEnabled(enabled, { ...emailLocalConfig, enabled })
                if (enabled && !emailIsRunning) {
                  await startEmailGateway()
                } else if (!enabled && emailIsRunning) {
                  await stopEmailGateway()
                }
              }}
              disabled={emailIsLoading || emailIsConnecting}
            />
            {emailIsRunning && emailHasChanges && (
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  await stopEmailGateway()
                  await saveEmailConfig(emailLocalConfig)
                  await startEmailGateway()
                  setEmailHasChanges(false)
                }}
                disabled={emailIsLoading || emailIsConnecting}
                className="h-7 gap-1.5 px-2.5 text-[12px]"
              >
                {emailIsLoading || emailIsConnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('settings.channels.restart', 'Restart')}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Collapsible Content */}
        {emailExpanded && (
          <div className="mt-4 pt-4 border-t space-y-6">
            {/* No credentials prompt */}
            {emailLocalConfig.provider === 'gmail' && !emailLocalConfig.gmailClientId && (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <GmailIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                <div className="flex-1">
                  <p className="text-[13px] font-medium">{t('settings.channels.email.noCredentials', 'No Gmail credentials configured')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.email.noCredentialsHint', 'Use the setup wizard to configure Gmail OAuth2 access.')}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setEmailWizardOpen(true)}>
                  <Sparkles className="h-4 w-4 mr-1" />
                  {t('settings.channels.startSetup', 'Start Setup')}
                </Button>
              </div>
            )}

            {/* Provider Selection */}
            <div>
              <label className="text-[13px] font-medium mb-2 block">{t('settings.channels.email.provider', 'Provider')}</label>
              <div className="flex gap-3">
                <button
                  className={cn(
                    'flex-1 flex items-center gap-2 p-3 rounded-lg border transition-all',
                    emailLocalConfig.provider === 'gmail'
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                      : 'border-muted hover:border-muted-foreground/30'
                  )}
                  onClick={() => updateEmailLocalConfig({ provider: 'gmail' })}
                >
                  <GmailIcon className="h-4 w-4" />
                  <span className="text-[13px] font-medium">{t('settings.channels.email.gmailOAuth', 'Gmail (OAuth2)')}</span>
                </button>
                <button
                  className={cn(
                    'flex-1 flex items-center gap-2 p-3 rounded-lg border transition-all',
                    emailLocalConfig.provider === 'custom'
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                      : 'border-muted hover:border-muted-foreground/30'
                  )}
                  onClick={() => updateEmailLocalConfig({ provider: 'custom' })}
                >
                  <Globe className="h-4 w-4" />
                  <span className="text-[13px] font-medium">{t('settings.channels.email.imapSmtp', 'IMAP/SMTP')}</span>
                </button>
              </div>
            </div>

            {/* Gmail Configuration */}
            {emailLocalConfig.provider === 'gmail' && (
              <div className="space-y-4">
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    <Key className="h-3.5 w-3.5 inline mr-1" />
                    {t('settings.channels.email.gmailClientId', 'Gmail Client ID')}
                  </label>
                  <Input
                    placeholder="your-client-id.apps.googleusercontent.com"
                    value={emailLocalConfig.gmailClientId}
                    onChange={(e) => updateEmailLocalConfig({ gmailClientId: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    <Shield className="h-3.5 w-3.5 inline mr-1" />
                    {t('settings.channels.email.gmailClientSecret', 'Gmail Client Secret')}
                  </label>
                  <Input
                    type="password"
                    placeholder="GOCSPX-..."
                    value={emailLocalConfig.gmailClientSecret}
                    onChange={(e) => updateEmailLocalConfig({ gmailClientSecret: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    <GmailIcon className="h-3.5 w-3.5 inline mr-1" />
                    {t('settings.channels.email.gmailAddress', 'Gmail Address')}
                  </label>
                  <Input
                    type="email"
                    placeholder={t('settings.channels.email.gmailAddressPlaceholder', 'your-email@gmail.com')}
                    value={emailLocalConfig.gmailEmail}
                    onChange={(e) => updateEmailLocalConfig({ gmailEmail: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={handleGmailAuthorize}
                    disabled={emailIsLoading || !emailLocalConfig.gmailClientId || !emailLocalConfig.gmailClientSecret || !emailLocalConfig.gmailEmail}
                    className="gap-2"
                  >
                    {emailIsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    {emailLocalConfig.gmailAuthorized ? t('settings.channels.email.reauthorize', 'Re-authorize') : t('settings.channels.email.authorizeGmail', 'Authorize Gmail')}
                  </Button>
                  {emailLocalConfig.gmailAuthorized && (
                    <span className="flex items-center gap-1 text-[13px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" />
                      {t('settings.channels.email.authorized', 'Authorized')}
                    </span>
                  )}
                </div>
                {gmailAuthUrl && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/20 p-3 space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t(
                        'settings.channels.email.gmailAuthUrlHint',
                        "If your browser didn't open automatically, copy the URL below and open it manually to complete authorization.",
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <Input readOnly value={gmailAuthUrl} className="text-xs font-mono" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigator.clipboard.writeText(gmailAuthUrl)}
                      >
                        {t('settings.channels.email.copy', 'Copy')}
                      </Button>
                    </div>
                  </div>
                )}
                {emailTestResult && (
                  <div className={cn(
                    'flex items-center gap-2 text-[13px] p-2 rounded',
                    emailTestResult?.success
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                  )}>
                    {emailTestResult?.success ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    {emailTestResult?.message}
                  </div>
                )}
              </div>
            )}

            {/* Custom IMAP/SMTP Configuration */}
            {emailLocalConfig.provider === 'custom' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.imapHost', 'IMAP Host')}</label>
                    <Input
                      placeholder="imap.example.com"
                      value={emailLocalConfig.imapServer}
                      onChange={(e) => updateEmailLocalConfig({ imapServer: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.imapPort', 'IMAP Port')}</label>
                    <Input
                      type="number"
                      placeholder="993"
                      value={emailLocalConfig.imapPort}
                      onChange={(e) => updateEmailLocalConfig({ imapPort: parseInt(e.target.value) || 993 })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.smtpHost', 'SMTP Host')}</label>
                    <Input
                      placeholder="smtp.example.com"
                      value={emailLocalConfig.smtpServer}
                      onChange={(e) => updateEmailLocalConfig({ smtpServer: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[13px] font-medium mb-1 block">{t('settings.channels.email.smtpPort', 'SMTP Port')}</label>
                    <Input
                      type="number"
                      placeholder="587"
                      value={emailLocalConfig.smtpPort}
                      onChange={(e) => updateEmailLocalConfig({ smtpPort: parseInt(e.target.value) || 587 })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    <Users className="h-3.5 w-3.5 inline mr-1" />
                    {t('settings.channels.email.username', 'Username')}
                  </label>
                  <Input
                    placeholder="your-email@example.com"
                    value={emailLocalConfig.username}
                    onChange={(e) => updateEmailLocalConfig({ username: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    <Key className="h-3.5 w-3.5 inline mr-1" />
                    {t('settings.channels.email.password', 'Password')}
                  </label>
                  <Input
                    type="password"
                    placeholder={t('settings.channels.email.passwordPlaceholder', 'Enter your password or app password')}
                    value={emailLocalConfig.password}
                    onChange={(e) => updateEmailLocalConfig({ password: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={handleTestEmailConnection}
                    disabled={emailIsTesting || !emailLocalConfig.imapServer || !emailLocalConfig.username}
                    className="gap-2"
                  >
                    {emailIsTesting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    {t('settings.channels.test', 'Test')}
                  </Button>
                </div>
                {emailTestResult && (
                  <div className={cn(
                    'flex items-center gap-2 text-[13px] p-2 rounded',
                    emailTestResult?.success
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                  )}>
                    {emailTestResult?.success ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    {emailTestResult?.message}
                  </div>
                )}
              </div>
            )}

            {/* Bot Display Name */}
            <div className="space-y-2">
              <label className="text-[13px] font-medium mb-1 block">
                {t('settings.channels.email.displayName', 'Bot Display Name')}
              </label>
              <Input
                placeholder={t('settings.channels.email.displayNamePlaceholder', { defaultValue: '{{appName}} Agent', appName: appDisplayName })}
                value={emailLocalConfig.displayName}
                onChange={(e) => updateEmailLocalConfig({ displayName: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.email.displayNameHint', 'Name shown in the From header of reply emails, e.g.')}{' '}
                <span className="font-mono">
                  {emailLocalConfig.displayName.trim() || `${appDisplayName} Agent`}
                  {' <'}
                  {(() => {
                    const baseEmail = emailLocalConfig.provider === 'gmail'
                      ? emailLocalConfig.gmailEmail
                      : emailLocalConfig.username
                    return baseEmail || 'email@example.com'
                  })()}
                  {'>'}
                </span>
              </p>
            </div>

            {/* Filter Settings */}
            <div className="space-y-4">
              <h4 className="text-[13px] font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4" />
                {t('settings.channels.email.filterSettings', 'Filter Settings')}
              </h4>

              {/* Recipient Alias (optional) */}
              <div className="p-3 rounded-lg bg-muted/30 space-y-3">
                <div>
                  <label className="text-[13px] font-medium mb-1 block">
                    {t('settings.channels.email.recipientAlias', 'Recipient Alias (optional)')}
                  </label>
                  <Input
                    placeholder="agent"
                    value={emailLocalConfig.recipientAlias}
                    onChange={(e) => updateEmailLocalConfig({ recipientAlias: e.target.value.replace(/\s+/g, '') })}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {emailLocalConfig.recipientAlias.trim() ? (
                    <>
                      {t('settings.channels.email.activeRecipient', 'Active Recipient:')}{' '}
                      <span className="font-mono">
                        {(() => {
                          const baseEmail = emailLocalConfig.provider === 'gmail'
                            ? emailLocalConfig.gmailEmail
                            : emailLocalConfig.username
                          const alias = emailLocalConfig.recipientAlias.trim()
                          const parts = baseEmail.split('@')
                          if (parts.length !== 2 || !alias) return t('settings.channels.email.notConfigured', '(not configured)')
                          const localBase = parts[0].split('+')[0]
                          return `${localBase}+${alias}@${parts[1]}`
                        })()}
                      </span>
                    </>
                  ) : (
                    t('settings.channels.email.noAliasConfigured', 'No alias configured. Only Allowed Senders controls which emails are processed.')
                  )}
                </div>
              </div>


              {/* Allowed Senders */}
              <div>
                <label className="text-[13px] font-medium mb-2 block">
                  {t('settings.channels.email.allowedSenders', 'Allowed Senders')}
                  <span className="text-xs text-muted-foreground ml-1">({t('settings.channels.email.senderPatternHint', 'email or pattern like *@company.com')})</span>
                </label>
                <div className="flex gap-2 mb-2">
                  <Input
                    placeholder={t('settings.channels.email.senderEmailPlaceholder', 'sender@example.com')}
                    value={newSender}
                    onChange={(e) => setNewSender(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddSender()}
                    className="flex-1"
                  />
                  <Button size="sm" onClick={handleAddSender} disabled={!newSender.trim()} title={t('settings.channels.email.addSender', 'Add Sender')}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {emailLocalConfig.allowedSenders.length === 0 && (
                  <p className="text-xs text-muted-foreground py-1">{t('settings.channels.email.noSenders', 'No senders configured. All emails will be ignored.')}</p>
                )}
                {emailLocalConfig.allowedSenders.length > 0 && (
                  <div className="space-y-1">
                    {emailLocalConfig.allowedSenders.map((sender) => (
                      <div key={sender} className="flex items-center justify-between p-2 rounded bg-muted/30 text-[13px]">
                        <span className="font-mono text-xs">{sender}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleRemoveSender(sender)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Labels (Gmail only) */}
              {emailLocalConfig.provider === 'gmail' && (
                <div>
                  <label className="text-[13px] font-medium mb-2 block">
                    {t('settings.channels.email.gmailLabels', 'Gmail Labels')}
                    <span className="text-xs text-muted-foreground ml-1">({t('settings.channels.email.gmailLabelsHint', 'only process emails with these labels')})</span>
                  </label>
                  <div className="flex gap-2 mb-2">
                    <Input
                      placeholder={t('settings.channels.email.labelPlaceholder', 'Label name')}
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddLabel()}
                      className="flex-1"
                    />
                    <Button size="sm" onClick={handleAddLabel} disabled={!newLabel.trim()}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {emailLocalConfig.labels.length > 0 && (
                    <div className="space-y-1">
                      {emailLocalConfig.labels.map((label) => (
                        <div key={label} className="flex items-center justify-between p-2 rounded bg-muted/30 text-[13px]">
                          <span className="font-mono text-xs">{label}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            onClick={() => handleRemoveLabel(label)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Save Button */}
            <Button
              className="w-full gap-2"
              onClick={handleEmailSave}
              disabled={emailIsLoading}
            >
              {emailIsLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.channels.saving', 'Saving...')}
                </>
              ) : (
                t('settings.channels.saveChanges', 'Save Changes')
              )}
            </Button>
          </div>
        )}
      </SettingCard>

      {/* Email Setup Wizard */}
      <EmailSetupWizard
        open={emailWizardOpen}
        onOpenChange={setEmailWizardOpen}
        onConfigSave={handleEmailWizardSave}
        existingConfig={emailLocalConfig}
      />

      {/* Delete Sender Confirmation */}
      <Dialog open={!!deleteSenderConfirm} onOpenChange={(open) => !open && setDeleteSenderConfirm(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('settings.channels.email.removeSender', 'Remove Sender')}</DialogTitle>
            <DialogDescription>
              {t('settings.channels.email.deleteSenderConfirm', 'Remove this sender from the allowed list?')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteSenderConfirm(null)}>
              {t('settings.channels.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteSenderConfirm && handleRemoveSender(deleteSenderConfirm)}
            >
              {t('common.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
