import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  AlertCircle,
  CheckCircle2,
  X,
  ExternalLink,
  Copy,
  Check,
  Sparkles,
  Bot,
  Link,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Zap,
} from 'lucide-react'
import { cn, openExternalUrl, copyToClipboard as copyToClipboardUtil } from '@/lib/utils'
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
import { type GuildConfig, type ChannelRule } from '@/stores/channels-types'
import { ToggleSwitch } from './shared'

// Setup Wizard Component - steps built with t() inside component
const getDiscordWizardSteps = (t: (key: string, options?: Record<string, unknown>) => string) => [
  { id: 'intro', title: t('settings.channels.discord.welcome', { defaultValue: 'Welcome to Discord Setup' }), description: t('settings.channels.discord.welcomeDesc', { defaultValue: "Let's connect your Discord bot to {{appName}} in a few simple steps.", appName: appDisplayName }) },
  { id: 'create-app', title: t('settings.channels.discord.createApp', { defaultValue: 'Create Discord Application' }), description: t('settings.channels.discord.createAppDesc', { defaultValue: 'First, we need to create a Discord application and bot.' }) },
  { id: 'get-token', title: t('settings.channels.discord.getToken', { defaultValue: 'Get Your Bot Token' }), description: t('settings.channels.discord.getTokenDesc', { defaultValue: "Copy your bot's secret token to authenticate." }) },
  { id: 'permissions', title: t('settings.channels.discord.permissions', { defaultValue: 'Configure Permissions' }), description: t('settings.channels.discord.permissionsDesc', { defaultValue: 'Set up the required permissions for your bot.' }) },
  { id: 'invite', title: t('settings.channels.discord.invite', { defaultValue: 'Invite Bot to Server' }), description: t('settings.channels.discord.inviteDesc', { defaultValue: 'Add your bot to a Discord server.' }) },
  { id: 'complete', title: t('settings.channels.discord.complete', { defaultValue: 'Setup Complete!' }), description: t('settings.channels.discord.completeDesc', { defaultValue: 'Your Discord bot is ready to use.' }) },
]

export function SetupWizard({
  open,
  onOpenChange,
  onTokenSave,
  existingToken,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTokenSave: (token: string) => void
  existingToken?: string
}) {
  const { t } = useTranslation()
  const WIZARD_STEPS = React.useMemo(() => getDiscordWizardSteps(t), [t])
  const [step, setStep] = React.useState(0)
  const [token, setToken] = React.useState(existingToken || '')
  const [clientId, setClientId] = React.useState('')
  const [copied, setCopied] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setToken(existingToken || '')
      setClientId('')
    }
  }, [open, existingToken])

  const handleCopy = async (text: string, id: string) => {
    await copyToClipboardUtil(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleNext = () => {
    if (step < WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleComplete = () => {
    if (token.trim()) {
      onTokenSave(token.trim())
    }
    onOpenChange(false)
  }

  // Generate invite URL with required permissions
  const inviteUrl = clientId
    ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=274877975552&scope=bot%20applications.commands`
    : ''

  const currentStep = WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/50 dark:to-purple-900/50">
                  <Bot className="h-16 w-16 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.discord.connectTitle', { defaultValue: 'Connect Discord to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {`This wizard will guide you through creating a Discord bot and connecting it to ${appDisplayName}.`}
                You'll be able to interact with AI directly from Discord channels and DMs.
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-indigo-100 dark:bg-indigo-900/50 p-2">
                  <Zap className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
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
                  <p className="text-[13px] font-medium">{t('settings.channels.securePrivate', 'Secure & Private')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.securePrivateDesc', 'Your token stays on your device')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'create-app':
        return (
          <div className="space-y-4">
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                <div className="flex items-start gap-3">
                  <BookOpen className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                  <div className="space-y-2 text-[13px]">
                    <p className="font-medium text-blue-900 dark:text-blue-100">{t('settings.channels.discord.createBotStepsTitle', 'Steps to create your bot:')}</p>
                    <ol className="list-decimal list-inside space-y-2 text-blue-800 dark:text-blue-200">
                      <li>{t('settings.channels.discord.createBotStep1', 'Go to the Discord Developer Portal')}</li>
                      <li>{t('settings.channels.discord.createBotStep2', 'Click "New Application"')}</li>
                      <li>{t('settings.channels.discord.createBotStep3', { defaultValue: 'Enter a name (e.g., "{{appName}} Bot") and create', appName: appDisplayName })}</li>
                      <li>{t('settings.channels.discord.createBotStep4', 'Navigate to "Bot" in the left sidebar')}</li>
                      <li>{t('settings.channels.discord.createBotStep5', 'Click "Add Bot" to create a bot user')}</li>
                    </ol>
                  </div>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => openExternalUrl('https://discord.com/developers/applications')}
              >
                <ExternalLink className="h-4 w-4" />
                {t('settings.channels.discord.openDevPortal', 'Open Discord Developer Portal')}
              </Button>

              <div className="pt-2 space-y-2">
                <p className="text-[13px] text-muted-foreground">
                  <strong>{t('settings.channels.discord.importantSettings', 'Important Bot Settings:')}</strong>
                </p>
                <div className="grid gap-2 text-[13px]">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-4 w-4 text-emerald-500" />
                    {t('settings.channels.discord.enableMessageIntent', 'Enable "Message Content Intent" in Bot settings')}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-4 w-4 text-emerald-500" />
                    {t('settings.channels.discord.disablePublicBot', '(Optional) Disable "Public Bot" for private use')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )

      case 'get-token':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div className="text-[13px]">
                  <p className="font-medium text-amber-900 dark:text-amber-100">{t('settings.channels.tokenSecretWarning', 'Keep your token secret!')}</p>
                  <p className="text-amber-800 dark:text-amber-200">
                    {t('settings.channels.tokenSecretDesc', 'Never share your bot token. If leaked, regenerate it immediately.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.discord.tokenPortalHint', 'In the Discord Developer Portal:')}
              </p>
              <ol className="list-decimal list-inside space-y-2 text-[13px] text-muted-foreground">
                <li>{t('settings.channels.discord.tokenStep1', 'Go to your application\'s "Bot" section')}</li>
                <li>{t('settings.channels.discord.tokenStep2', 'Click "Reset Token" or "View Token"')}</li>
                <li>{t('settings.channels.discord.tokenStep3', 'Copy the token and paste it below')}</li>
              </ol>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.discord.botToken', 'Bot Token')}</label>
              <div className="relative">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={t('settings.channels.discord.tokenPlaceholder', 'Paste your bot token here...')}
                  className="pr-10"
                />
                <Key className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {token && (
              <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {t('settings.channels.tokenEntered', 'Token entered')}
              </div>
            )}
          </div>
        )

      case 'permissions':
        return (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('settings.channels.discord.permissionsIntro', 'Your bot needs these permissions to work properly:')}
            </p>

            <div className="space-y-2">
              {[
                { name: t('settings.channels.discord.permReadMessages', 'Read Messages/View Channels'), desc: t('settings.channels.discord.permReadMessagesDesc', 'See channel messages') },
                { name: t('settings.channels.discord.permSendMessages', 'Send Messages'), desc: t('settings.channels.discord.permSendMessagesDesc', 'Reply to users') },
                { name: t('settings.channels.discord.permSendThreads', 'Send Messages in Threads'), desc: t('settings.channels.discord.permSendThreadsDesc', 'Respond in thread conversations') },
                { name: t('settings.channels.discord.permEmbedLinks', 'Embed Links'), desc: t('settings.channels.discord.permEmbedLinksDesc', 'Send rich formatted messages') },
                { name: t('settings.channels.discord.permAttachFiles', 'Attach Files'), desc: t('settings.channels.discord.permAttachFilesDesc', 'Send images and files') },
                { name: t('settings.channels.discord.permReadHistory', 'Read Message History'), desc: t('settings.channels.discord.permReadHistoryDesc', 'Access previous messages') },
                { name: t('settings.channels.discord.permAddReactions', 'Add Reactions'), desc: t('settings.channels.discord.permAddReactionsDesc', 'React to messages') },
              ].map((perm) => (
                <div key={perm.name} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                  <Check className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-medium">{perm.name}</p>
                    <p className="text-xs text-muted-foreground">{perm.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 rounded-lg bg-muted/50 text-[13px] text-muted-foreground">
              {t('settings.channels.discord.permissionsAutoInclude', 'These permissions will be automatically included in the invite link on the next step.')}
            </div>
          </div>
        )

      case 'invite':
        return (
          <div className="space-y-4 overflow-hidden">
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.discord.inviteIntro', 'To generate an invite link, we need your Application ID (Client ID):')}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-[13px] text-muted-foreground">
                <li>{t('settings.channels.discord.inviteStep1', 'Go to your application in the Developer Portal')}</li>
                <li>{t('settings.channels.discord.inviteStep2', 'Find "Application ID" in General Information')}</li>
                <li>{t('settings.channels.discord.inviteStep3', 'Copy and paste it below')}</li>
              </ol>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.discord.applicationId', 'Application ID (Client ID)')}</label>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="e.g., 123456789012345678"
              />
            </div>

            {clientId && (
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                  <p className="text-[13px] font-medium text-emerald-900 dark:text-emerald-100 mb-2">
                    {t('settings.channels.discord.inviteLinkReady', 'Your invite link is ready!')}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <code className="text-xs bg-white dark:bg-gray-900 p-2 rounded block truncate w-full">
                        {inviteUrl}
                      </code>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 flex-shrink-0"
                      onClick={() => handleCopy(inviteUrl, 'invite')}
                    >
                      {copied === 'invite' ? (
                        <Check className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => openExternalUrl(inviteUrl)}
                >
                  <Link className="h-4 w-4" />
                  {t('settings.channels.discord.openInviteLink', 'Open Invite Link')}
                </Button>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t('settings.channels.discord.selectServerHint', 'Select a server and authorize the bot with the required permissions.')}
            </p>
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
                {t('settings.channels.discord.completeMessage', 'Your Discord bot is now configured. Click "Finish" to save your settings and start using the bot.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-[13px] font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-[13px] text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.discord.nextStepConfigure', 'Configure DM and server settings')}</li>
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
            <Sparkles className="h-5 w-5 text-indigo-500" />
            {currentStep.title}
          </DialogTitle>
          <DialogDescription>
            {currentStep.description}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        <div className="flex items-center gap-1 py-2">
          {WIZARD_STEPS.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                "flex-1 h-1.5 rounded-full transition-colors",
                i <= step ? "bg-indigo-500" : "bg-muted"
              )}
            />
          ))}
        </div>

        <div className="py-4 min-h-[300px] overflow-hidden">
          {renderStepContent()}
        </div>

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          {step > 0 && step < WIZARD_STEPS.length - 1 && (
            <Button variant="outline" onClick={handleBack} className="gap-1">
              <ArrowLeft className="h-4 w-4" />
              {t('settings.channels.back', 'Back')}
            </Button>
          )}
          <div className="flex-1" />
          {step === 0 && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('settings.channels.skip', 'Skip')}
            </Button>
          )}
          {step < WIZARD_STEPS.length - 1 ? (
            <Button
              onClick={handleNext}
              className="gap-1"
              disabled={step === 2 && !token}
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

// Channel Configuration Dialog
export function ChannelConfigDialog({
  open,
  onOpenChange,
  channel,
  channelId,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel?: ChannelRule
  channelId?: string
  onSave: (channelId: string, rule: ChannelRule) => void
}) {
  const { t } = useTranslation()
  const [id, setId] = React.useState(channelId || '')
  const [allow, setAllow] = React.useState(channel?.allow ?? true)
  const [requireMention, setRequireMention] = React.useState<boolean | undefined>(
    channel?.requireMention
  )
  const [users, setUsers] = React.useState(channel?.users?.join(', ') || '')

  React.useEffect(() => {
    if (open) {
      setId(channelId || '')
      setAllow(channel?.allow ?? true)
      setRequireMention(channel?.requireMention)
      setUsers(channel?.users?.join(', ') || '')
    }
  }, [open, channel, channelId])

  const handleSave = () => {
    if (!id.trim()) return

    const rule: ChannelRule = {
      allow,
      requireMention,
      users: users.split(',').map(s => s.trim()).filter(Boolean),
    }

    onSave(id.trim(), rule)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{channelId ? t('settings.channels.editChannel', 'Edit Channel') : t('settings.channels.addChannel', 'Add Channel')}</DialogTitle>
          <DialogDescription>
            {t('settings.channels.configureChannel', 'Configure settings for a specific channel.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.channelId', 'Channel ID')}</label>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="123456789012345678 or *"
              disabled={!!channelId}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.channelIdHint', 'Use * as wildcard to match all channels in this server')}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-[13px] font-medium">{t('settings.channels.channelAllow', 'Allow')}</label>
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.channelAllowDesc', 'Enable bot responses in this channel')}
              </p>
            </div>
            <ToggleSwitch enabled={allow} onChange={setAllow} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-[13px] font-medium">{t('settings.channels.requireMention', 'Require @mention')}</label>
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.requireMentionDesc', 'Bot only responds when mentioned')}
              </p>
            </div>
            <ToggleSwitch
              enabled={requireMention ?? true}
              onChange={(v) => setRequireMention(v)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.allowedUsers', 'Allowed Users')} ({t('settings.channels.optional', 'optional')})</label>
            <Input
              value={users}
              onChange={(e) => setUsers(e.target.value)}
              placeholder={t('settings.channels.allowedUsersPlaceholder', 'user_id_1, user_id_2, ...')}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.allowedUsersHint', 'Comma-separated user IDs. Leave empty to allow all.')}
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

// Guild Configuration Dialog
export function GuildConfigDialog({
  open,
  onOpenChange,
  guild,
  guildId,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  guild?: GuildConfig
  guildId?: string
  onSave: (guildId: string, config: GuildConfig) => void
}) {
  const { t } = useTranslation()
  const [id, setId] = React.useState(guildId || '')
  const [slug, setSlug] = React.useState(guild?.slug || '')

  React.useEffect(() => {
    if (open) {
      setId(guildId || '')
      setSlug(guild?.slug || '')
    }
  }, [open, guild, guildId])

  const handleSave = () => {
    if (!id.trim()) return

    const config: GuildConfig = {
      slug: slug.trim() || undefined,
      channels: guild?.channels || {},
    }

    onSave(id.trim(), config)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{guildId ? t('settings.channels.editServer', 'Edit Server') : t('settings.channels.addServer', 'Add Server')}</DialogTitle>
          <DialogDescription>
            {t('settings.channels.configureServer', 'Configure settings for a server.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.serverId', 'Server ID')}</label>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="123456789012345678 or *"
              disabled={!!guildId}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.serverIdHint', 'Use * for default settings applied to all servers')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.serverName', 'Name (optional)')}</label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t('settings.channels.serverNamePlaceholder', 'My Server')}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.channels.serverNameHint', 'Friendly name for display purposes')}
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

// Delete confirmation dialog for guilds
export function DeleteGuildDialog({
  deleteGuildConfirm,
  onClose,
  onDelete,
}: {
  deleteGuildConfirm: string | null
  onClose: () => void
  onDelete: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={!!deleteGuildConfirm} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('settings.channels.deleteServer', 'Delete Server')}</DialogTitle>
          <DialogDescription>
            {t('settings.channels.deleteServerConfirm', { id: deleteGuildConfirm || '', defaultValue: 'Are you sure you want to remove server "{{id}}" and all its channel configurations?' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('settings.channels.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteGuildConfirm && onDelete(deleteGuildConfirm)}
          >
            {t('settings.channels.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Delete confirmation dialog for channels
export function DeleteChannelDialog({
  deleteChannelConfirm,
  onClose,
  onDelete,
}: {
  deleteChannelConfirm: { guildId: string; channelId: string } | null
  onClose: () => void
  onDelete: (guildId: string, channelId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={!!deleteChannelConfirm} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('settings.channels.deleteChannel', 'Delete Channel')}</DialogTitle>
          <DialogDescription>
            {t('settings.channels.deleteChannelConfirm', { id: deleteChannelConfirm?.channelId || '', defaultValue: 'Are you sure you want to remove channel "{{id}}" from this server?' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('settings.channels.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteChannelConfirm && onDelete(deleteChannelConfirm.guildId, deleteChannelConfirm.channelId)}
          >
            {t('settings.channels.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Re-export X icon for use in parent
export { X }
