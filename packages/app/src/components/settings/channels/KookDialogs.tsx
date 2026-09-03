import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  AlertCircle,
  CheckCircle2,
  Check,
  Sparkles,
  Bot,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Zap,
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
import { type KookGuildConfig, type KookChannelRule } from '@/stores/channels-types'
import { KookIcon, ToggleSwitch } from './shared'

// KOOK Setup Wizard
const KOOK_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.kook.wizardIntroTitle',
    title: 'Welcome to KOOK Setup',
    descKey: 'settings.channels.kook.wizardIntroDesc',
    description: `Let's connect your KOOK bot to ${appDisplayName} in a few simple steps.`,
  },
  {
    id: 'create-bot',
    titleKey: 'settings.channels.kook.wizardCreateTitle',
    title: 'Create KOOK Bot',
    descKey: 'settings.channels.kook.wizardCreateDesc',
    description: 'Create a bot application in KOOK Developer Portal.',
  },
  {
    id: 'get-token',
    titleKey: 'settings.channels.kook.wizardTokenTitle',
    title: 'Get Your Bot Token',
    descKey: 'settings.channels.kook.wizardTokenDesc',
    description: 'Copy your bot token to authenticate.',
  },
  {
    id: 'permissions',
    titleKey: 'settings.channels.kook.wizardPermissionsTitle',
    title: 'Configure Bot Permissions',
    descKey: 'settings.channels.kook.wizardPermissionsDesc',
    description: 'Set up required permissions for your bot.',
  },
  {
    id: 'invite',
    titleKey: 'settings.channels.kook.wizardInviteTitle',
    title: 'Invite Bot to Server',
    descKey: 'settings.channels.kook.wizardInviteDesc',
    description: 'Add your bot to a KOOK server.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.kook.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.kook.wizardCompleteDesc',
    description: 'Your KOOK bot is ready to use.',
  },
]

export function KookSetupWizard({
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
  const [step, setStep] = React.useState(0)
  const [token, setToken] = React.useState(existingToken || '')

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setToken(existingToken || '')
    }
  }, [open, existingToken])

  const handleNext = () => {
    if (step < KOOK_WIZARD_STEPS.length - 1) {
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

  const currentStep = KOOK_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-orange-100 to-yellow-100 dark:from-orange-900/50 dark:to-yellow-900/50">
                  <Bot className="h-16 w-16 text-orange-600 dark:text-orange-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.kook.connectTitle', { defaultValue: 'Connect KOOK to {{appName}}', appName: appDisplayName })}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.kook.connectDesc', { defaultValue: "This wizard will guide you through creating a KOOK bot and connecting it to {{appName}}. You'll be able to interact with AI directly from KOOK servers and DMs.", appName: appDisplayName })}
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-orange-100 dark:bg-orange-900/50 p-2">
                  <Zap className="h-4 w-4 text-orange-600 dark:text-orange-400" />
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
                  <p className="text-[13px] font-medium">{t('settings.channels.kook.websocket', 'WebSocket Long Connection')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.kook.websocketDesc', 'No public server needed, runs locally')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'create-bot':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800">
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-orange-600 dark:text-orange-400 mt-0.5" />
                <div className="space-y-2 text-[13px]">
                  <p className="font-medium text-orange-900 dark:text-orange-100">{t('settings.channels.kook.createBotStepsTitle', 'Steps to create your KOOK bot:')}</p>
                  <ol className="list-decimal list-inside space-y-2 text-orange-800 dark:text-orange-200">
                    <li>{t('settings.channels.kook.createBotStep1', 'Go to the KOOK Developer Portal')}</li>
                    <li>{t('settings.channels.kook.createBotStep2', 'Click "Create Application"')}</li>
                    <li>{t('settings.channels.kook.createBotStep3', { defaultValue: 'Enter a name (e.g., "{{appName}} Bot") and icon', appName: appDisplayName })}</li>
                    <li>{t('settings.channels.kook.createBotStep4', 'Select "Bot" type')}</li>
                    <li>{t('settings.channels.kook.createBotStep5', 'Click "Create"')}</li>
                  </ol>
                </div>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => openExternalUrl('https://developer.kookapp.cn/app/index')}
            >
              <ExternalLink className="h-4 w-4" />
              {t('settings.channels.kook.openDevPortal', 'Open KOOK Developer Portal')}
            </Button>
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
                    {t('settings.channels.kook.tokenSecretDesc', 'Never share your Bot Token. It is stored locally on your device.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.kook.tokenPortalHint', 'In the KOOK Developer Portal, go to your bot application and find the "Token" section:')}
              </p>
              <ol className="list-decimal list-inside text-[13px] text-muted-foreground space-y-1">
                <li>{t('settings.channels.kook.tokenStep1', 'Navigate to "Bot" tab')}</li>
                <li>{t('settings.channels.kook.tokenStep2', 'Click "Get Token" or copy the existing token')}</li>
                <li>{t('settings.channels.kook.tokenStep3', 'Paste it below')}</li>
              </ol>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">{t('settings.channels.kook.botToken', 'Bot Token')}</label>
              <div className="relative">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={t('settings.channels.kook.botTokenPlaceholder', 'Your KOOK bot token')}
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
              {t('settings.channels.kook.permissionsIntro', 'Configure the following permissions for your bot:')}
            </p>

            <div className="space-y-2">
              {[
                { name: t('settings.channels.kook.permReadMessages', 'Read Messages'), desc: t('settings.channels.kook.permReadMessagesDesc', 'Receive messages from servers and DMs') },
                { name: t('settings.channels.kook.permSendMessages', 'Send Messages'), desc: t('settings.channels.kook.permSendMessagesDesc', 'Reply to user messages') },
                { name: t('settings.channels.kook.permViewServer', 'View Server Info'), desc: t('settings.channels.kook.permViewServerDesc', 'Access server and channel information') },
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

            <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
              <p className="text-[13px] text-blue-900 dark:text-blue-100">
                {t('settings.channels.kook.permissionsNote', 'Note: Make sure your bot has "Message Permissions" enabled in the Developer Portal.')}
              </p>
            </div>
          </div>
        )

      case 'invite':
        return (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('settings.channels.kook.inviteIntro', 'To use your bot, you need to invite it to a KOOK server:')}
            </p>

            <div className="space-y-3">
              <div className="p-4 rounded-lg bg-muted/50 text-[13px] space-y-2">
                <p className="font-medium">{t('settings.channels.kook.inviteStepsTitle', 'Invite Steps:')}</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                  <li>{t('settings.channels.kook.inviteStep1', 'Go to the KOOK Developer Portal')}</li>
                  <li>{t('settings.channels.kook.inviteStep2', 'Click your bot application')}</li>
                  <li>{t('settings.channels.kook.inviteStep3', 'Go to "Bot" tab')}</li>
                  <li>{t('settings.channels.kook.inviteStep4', 'Copy the "Invite Link"')}</li>
                  <li>{t('settings.channels.kook.inviteStep5', 'Open the link in browser to add bot to server')}</li>
                </ol>
              </div>

              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <p className="text-[13px] text-amber-900 dark:text-amber-100">
                  {t('settings.channels.kook.inviteAdminNote', 'You need server admin permissions to invite bots.')}
                </p>
              </div>
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
              <h3 className="text-lg font-semibold">{t('settings.channels.kook.complete', 'Setup Complete!')}</h3>
              <p className="text-[13px] text-muted-foreground">
                {t('settings.channels.kook.completeMessage', 'Your KOOK bot is now configured. Click "Finish" to save your settings and start using the bot.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-[13px] font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-[13px] text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.kook.nextStepConfigure', 'Configure server/channel settings if needed')}</li>
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
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KookIcon className="h-5 w-5 text-blue-600" />
            {t(currentStep.titleKey, currentStep.title)}
          </DialogTitle>
          <DialogDescription>{t(currentStep.descKey, currentStep.description)}</DialogDescription>
        </DialogHeader>

        {/* Progress */}
        <div className="flex gap-1 mb-2">
          {KOOK_WIZARD_STEPS.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= step ? 'bg-blue-500' : 'bg-muted'
              )}
            />
          ))}
        </div>

        <div className="py-4">
          {renderStepContent()}
        </div>

        <DialogFooter className="flex justify-between">
          {step > 0 && (
            <Button variant="outline" onClick={handleBack} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('settings.channels.back', 'Back')}
            </Button>
          )}
          <div className="flex-1" />
          {step < KOOK_WIZARD_STEPS.length - 1 ? (
            <Button onClick={handleNext} className="gap-2">
              {t('settings.channels.next', 'Next')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleComplete} disabled={!token.trim()} className="gap-2">
              <Check className="h-4 w-4" />
              {t('settings.channels.finish', 'Finish')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// KOOK Guild Configuration Dialog
export function KookGuildConfigDialog({
  open,
  onOpenChange,
  guild,
  guildId,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  guild?: KookGuildConfig
  guildId?: string
  onSave: (guildId: string, config: KookGuildConfig) => void
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
    const config: KookGuildConfig = {
      enabled: true,
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

// KOOK Channel Configuration Dialog
export function KookChannelConfigDialog({
  open,
  onOpenChange,
  channel,
  channelId,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel?: KookChannelRule
  channelId?: string
  onSave: (channelId: string, rule: KookChannelRule) => void
}) {
  const { t } = useTranslation()
  const [id, setId] = React.useState(channelId || '')
  const [enabled, setEnabled] = React.useState(channel?.enabled ?? true)
  const [requireMention, setRequireMention] = React.useState(channel?.requireMention ?? true)
  const [users, setUsers] = React.useState(channel?.allowedUsers?.join(', ') || '')

  React.useEffect(() => {
    if (open) {
      setId(channelId || '')
      setEnabled(channel?.enabled ?? true)
      setRequireMention(channel?.requireMention ?? true)
      setUsers(channel?.allowedUsers?.join(', ') || '')
    }
  }, [open, channel, channelId])

  const handleSave = () => {
    if (!id.trim()) return
    const rule: KookChannelRule = {
      enabled,
      requireMention,
      allowedUsers: users.split(',').map(s => s.trim()).filter(Boolean),
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
              <label className="text-[13px] font-medium">{t('settings.channels.channelEnabled', 'Enabled')}</label>
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.channelEnabledDesc', 'Enable bot responses in this channel')}
              </p>
            </div>
            <ToggleSwitch enabled={enabled} onChange={setEnabled} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-[13px] font-medium">{t('settings.channels.requireMention', 'Require @mention')}</label>
              <p className="text-xs text-muted-foreground">
                {t('settings.channels.requireMentionDesc', 'Bot only responds when mentioned')}
              </p>
            </div>
            <ToggleSwitch enabled={requireMention} onChange={setRequireMention} />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">{t('settings.channels.allowedUsers', 'Allowed Users')}</label>
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

// Delete guild confirmation dialog
export function KookDeleteGuildDialog({
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
            {t('settings.channels.deleteServerConfirm', 'Are you sure you want to remove server "{{id}}" and all its channel configurations?', { id: deleteGuildConfirm })}
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

// Delete channel confirmation dialog
export function KookDeleteChannelDialog({
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
            {t('settings.channels.deleteChannelConfirm', 'Are you sure you want to remove channel "{{id}}" from this server?', { id: deleteChannelConfirm?.channelId })}
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
