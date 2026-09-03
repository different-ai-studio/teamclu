import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  Users,
  Hash,
  Server,
  Plus,
  Trash2,
  Edit2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Bot,
  BookOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useChannelsStore,
  type DiscordConfig,
  type GuildConfig,
  type DmConfig,
  type ChannelRule,
  defaultDiscordConfig,
} from '@/stores/channels'
import { DiscordIcon, SettingCard, ToggleSwitch, StatusBadge } from './shared'
import {
  SetupWizard,
  ChannelConfigDialog,
  GuildConfigDialog,
  DeleteGuildDialog,
  DeleteChannelDialog,
  X,
} from './DiscordDialogs'
import { useShallow } from 'zustand/react/shallow'

export function DiscordChannel() {
  const { t } = useTranslation()
  const {
    discord,
    isLoading,
    gatewayStatus,
    hasChanges,
    isTesting,
    testResult,
    saveDiscordConfig,
    startGateway,
    stopGateway,
    refreshStatus,
    testToken,
    clearTestResult,
    setHasChanges,
    toggleDiscordEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ discord: s.discord, isLoading: s.isLoading, gatewayStatus: s.gatewayStatus, hasChanges: s.hasChanges, isTesting: s.isTesting, testResult: s.testResult, saveDiscordConfig: s.saveDiscordConfig, startGateway: s.startGateway, stopGateway: s.stopGateway, refreshStatus: s.refreshStatus, testToken: s.testToken, clearTestResult: s.clearTestResult, setHasChanges: s.setHasChanges, toggleDiscordEnabled: s.toggleDiscordEnabled })),
  )

  const [localConfig, setLocalConfig] = React.useState<DiscordConfig>(defaultDiscordConfig)
  const [guildDialogOpen, setGuildDialogOpen] = React.useState(false)
  const [editingGuild, setEditingGuild] = React.useState<{ id: string; config: GuildConfig } | null>(null)
  const [expandedGuilds, setExpandedGuilds] = React.useState<Set<string>>(new Set())
  const [deleteGuildConfirm, setDeleteGuildConfirm] = React.useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = React.useState(false)
  const [discordExpanded, setDiscordExpanded] = React.useState(false)
  const [channelDialogOpen, setChannelDialogOpen] = React.useState(false)
  const [editingChannel, setEditingChannel] = React.useState<{
    guildId: string
    channelId: string
    rule: ChannelRule
  } | null>(null)
  const [addingChannelForGuild, setAddingChannelForGuild] = React.useState<string | null>(null)
  const [deleteChannelConfirm, setDeleteChannelConfirm] = React.useState<{
    guildId: string
    channelId: string
  } | null>(null)

  // Sync local config with store
  React.useEffect(() => {
    if (discord) {
      setLocalConfig(discord)
    }
  }, [discord])

  // Refresh status periodically when connected
  React.useEffect(() => {
    if (gatewayStatus.status === 'connected' || gatewayStatus.status === 'connecting') {
      const interval = setInterval(refreshStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [gatewayStatus.status, refreshStatus])

  const updateLocalConfig = (updates: Partial<DiscordConfig>) => {
    setLocalConfig(prev => ({ ...prev, ...updates }))
  }

  const updateDmConfig = (updates: Partial<DmConfig>) => {
    setLocalConfig(prev => ({
      ...prev,
      dm: { ...prev.dm, ...updates },
    }))
  }

  const handleSave = async () => {
    try {
      await saveDiscordConfig(localConfig)
      if (isRunning) {
        setHasChanges(true)
      }
    } catch {
      // Error is handled by the store
    }
  }

  const handleTestToken = async () => {
    if (!localConfig.token) return
    await testToken(localConfig.token)
  }

  const handleAddGuild = (guildId: string, config: GuildConfig) => {
    setLocalConfig(prev => ({
      ...prev,
      guilds: { ...prev.guilds, [guildId]: config },
    }))
  }

  const handleUpdateGuild = (guildId: string, config: GuildConfig) => {
    setLocalConfig(prev => ({
      ...prev,
      guilds: { ...prev.guilds, [guildId]: config },
    }))
  }

  const handleDeleteGuild = (guildId: string) => {
    setLocalConfig(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [guildId]: _, ...rest } = prev.guilds
      return { ...prev, guilds: rest }
    })
    setDeleteGuildConfirm(null)
  }

  const handleAddChannel = (channelId: string, rule: ChannelRule) => {
    if (!addingChannelForGuild) return
    const guildId = addingChannelForGuild
    setLocalConfig(prev => ({
      ...prev,
      guilds: {
        ...prev.guilds,
        [guildId]: {
          ...prev.guilds[guildId],
          channels: { ...prev.guilds[guildId].channels, [channelId]: rule },
        },
      },
    }))
    setAddingChannelForGuild(null)
  }

  const handleUpdateChannel = (channelId: string, rule: ChannelRule) => {
    if (!editingChannel) return
    const guildId = editingChannel.guildId
    setLocalConfig(prev => ({
      ...prev,
      guilds: {
        ...prev.guilds,
        [guildId]: {
          ...prev.guilds[guildId],
          channels: { ...prev.guilds[guildId].channels, [channelId]: rule },
        },
      },
    }))
  }

  const handleDeleteChannel = (guildId: string, channelId: string) => {
    setLocalConfig(prev => {
      const guild = prev.guilds[guildId]
      if (!guild) return prev
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [channelId]: _, ...restChannels } = guild.channels
      return {
        ...prev,
        guilds: {
          ...prev.guilds,
          [guildId]: { ...guild, channels: restChannels },
        },
      }
    })
    setDeleteChannelConfirm(null)
  }

  const handleWizardTokenSave = (newToken: string) => {
    setLocalConfig(prev => ({ ...prev, token: newToken, enabled: true }))
  }

  const toggleGuildExpand = (guildId: string) => {
    setExpandedGuilds(prev => {
      const next = new Set(prev)
      if (next.has(guildId)) {
        next.delete(guildId)
      } else {
        next.add(guildId)
      }
      return next
    })
  }

  const isConnecting = gatewayStatus.status === 'connecting'
  const isRunning = gatewayStatus.status === 'connected' || isConnecting

  if (!discord) return null

  return (
    <>
      <SettingCard className="!p-3">
        {/* Header Row - always visible */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setDiscordExpanded(!discordExpanded)}
            className="flex items-center gap-3 flex-1 text-left"
          >
            <div className="rounded-md p-1.5 bg-indigo-100 dark:bg-indigo-900/50">
              <DiscordIcon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{t('settings.channels.discord.gateway', 'Discord Gateway')}</span>
                <StatusBadge status={gatewayStatus.status} />
              </div>
              {gatewayStatus.botUsername && (
                <p className="text-xs text-muted-foreground">
                  {t('settings.channels.connectedAs', { name: gatewayStatus.botUsername, defaultValue: 'Connected as @{{name}}' })}
                </p>
              )}
              {gatewayStatus.connectedGuilds.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('settings.channels.guildsConnected', { count: gatewayStatus.connectedGuilds.length, defaultValue: '{{count}} guild(s) connected' })}
                </p>
              )}
              {gatewayStatus.errorMessage && (
                <p className="text-xs text-red-500">{gatewayStatus.errorMessage}</p>
              )}
            </div>
            {discordExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWizardOpen(true)}
              className="h-7 w-7 p-0"
              title={t('settings.channels.startSetup', 'Start Setup')}
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </Button>
            <ToggleSwitch
              enabled={localConfig.enabled}
              onChange={async (enabled) => {
                updateLocalConfig({ enabled })
                await toggleDiscordEnabled(enabled, { ...localConfig, enabled })
                if (enabled && !isRunning) {
                  await startGateway()
                } else if (!enabled && isRunning) {
                  await stopGateway()
                }
              }}
              disabled={isLoading || isConnecting}
            />
            {isRunning && hasChanges && (
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  await stopGateway()
                  await saveDiscordConfig(localConfig)
                  await startGateway()
                  setHasChanges(false)
                }}
                disabled={isLoading || isConnecting}
                className="h-7 gap-1.5 px-2.5 text-[12px]"
              >
                {isLoading || isConnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('common.restart', 'Restart')}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Collapsible Content */}
        {discordExpanded && (
          <div className="mt-5 pt-5 border-t space-y-5">

            {/* Setup Wizard Prompt - Show when no token */}
            {!localConfig.token && (
              <div className="p-4 rounded-lg bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 border border-indigo-200 dark:border-indigo-800">
                <div className="flex items-center gap-4">
                  <Bot className="h-8 w-8 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-indigo-900 dark:text-indigo-100">
                      {t('settings.channels.discord.setupTitle', 'Set up Discord Integration')}
                    </h4>
                    <p className="text-[13px] text-indigo-700 dark:text-indigo-300 mt-1">
                      {t('settings.channels.discord.setupDesc', 'Connect a Discord bot to interact with AI from Discord channels and DMs.')}
                    </p>
                  </div>
                  <Button onClick={() => setWizardOpen(true)} size="sm" className="gap-2 flex-shrink-0">
                    <Sparkles className="h-4 w-4" />
                    {t('settings.channels.startSetup', 'Start Setup')}
                  </Button>
                </div>
              </div>
            )}

            {/* Bot Token */}
            <div className="space-y-2">
              <label className="text-[13px] font-medium flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                {t('settings.channels.discord.botToken', 'Bot Token')}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="password"
                    value={localConfig.token}
                    onChange={(e) => updateLocalConfig({ token: e.target.value })}
                    placeholder={t('settings.channels.discord.tokenPlaceholder', 'Your Discord bot token')}
                    className="pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <Button
                  variant="outline"
                  onClick={handleTestToken}
                  disabled={isTesting || !localConfig.token}
                >
                  {isTesting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('settings.channels.test', 'Test')
                  )}
                </Button>
              </div>
              {testResult && (
                <div className={cn(
                  "flex items-center gap-2 text-[13px]",
                  testResult.success ? "text-emerald-600" : "text-red-600"
                )}>
                  {testResult.success ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {testResult.message}
                  <Button variant="ghost" size="sm" className="h-4 w-4 p-0" onClick={clearTestResult}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" />
                {t('settings.channels.tokenStoredLocally', 'Your token is stored locally and never sent to our servers.')}
              </p>
            </div>

            {/* DM Settings */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-medium flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                {t('settings.channels.directMessages', 'Direct Messages')}
              </h4>
              <div className="space-y-3 pl-6">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-[13px] font-medium">{t('settings.channels.enableDMs', 'Enable DMs')}</label>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.channels.enableDMsDesc', 'Allow users to message the bot directly')}
                    </p>
                  </div>
                  <ToggleSwitch
                    enabled={localConfig.dm.enabled}
                    onChange={(enabled) => updateDmConfig({ enabled })}
                  />
                </div>

                {localConfig.dm.enabled && (
                  <>
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium">{t('settings.channels.accessPolicy', 'Access Policy')}</label>
                      <Select
                        value={localConfig.dm.policy}
                        onValueChange={(policy: DmConfig['policy']) => updateDmConfig({ policy })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">{t('settings.channels.policyOpen', 'Open - Allow anyone')}</SelectItem>
                          <SelectItem value="allowlist">{t('settings.channels.policyAllowlist', 'Allowlist - Only specific users')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {localConfig.dm.policy === 'allowlist' && (
                      <div className="space-y-2">
                        <label className="text-[13px] font-medium">{t('settings.channels.allowedUsers', 'Allowed Users')}</label>
                        <Input
                          value={localConfig.dm.allowFrom.join(', ')}
                          onChange={(e) =>
                            updateDmConfig({
                              allowFrom: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                            })
                          }
                          placeholder={t('settings.channels.allowedUsersPlaceholder', 'user_id_1, user_id_2, ...')}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('settings.channels.allowedUsersHint', 'Comma-separated user IDs. Leave empty to allow all.')}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Guild Settings */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-[13px] font-medium flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  {t('settings.channels.serverSettings', 'Server Settings')}
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingGuild(null)
                    setGuildDialogOpen(true)
                  }}
                  className="gap-2 h-7 text-xs"
                >
                  <Plus className="h-3 w-3" />
                  {t('settings.channels.addServer', 'Add Server')}
                </Button>
              </div>

              <div className="pl-6">
                {Object.keys(localConfig.guilds).length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-[13px] font-medium">{t('settings.channels.noServers', 'No servers configured')}</p>
                    <p className="text-xs">{t('settings.channels.noServersHint', 'Add a server to allow the bot to respond in server channels')}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(localConfig.guilds).map(([guildId, config]) => (
                      <div
                        key={guildId}
                        className="border rounded-lg p-3"
                      >
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => toggleGuildExpand(guildId)}
                            className="flex items-center gap-2 text-left flex-1"
                          >
                            {expandedGuilds.has(guildId) ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            <Hash className="h-4 w-4 text-indigo-500" />
                            <span className="text-[13px] font-medium">{config.slug || guildId}</span>
                            {guildId === '*' && (
                              <span className="text-xs bg-muted px-2 py-0.5 rounded">{t('common.default', 'Default')}</span>
                            )}
                          </button>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => {
                                setEditingGuild({ id: guildId, config })
                                setGuildDialogOpen(true)
                              }}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              onClick={() => setDeleteGuildConfirm(guildId)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        {expandedGuilds.has(guildId) && (
                          <div className="mt-3 pt-3 border-t space-y-3">
                            {/* Channels */}
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium flex items-center gap-1.5">
                                  <Hash className="h-3 w-3 text-muted-foreground" />
                                  {t('settings.channels.channels', 'Channels')}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs px-2 gap-1"
                                  onClick={() => {
                                    setAddingChannelForGuild(guildId)
                                    setEditingChannel(null)
                                    setChannelDialogOpen(true)
                                  }}
                                >
                                  <Plus className="h-3 w-3" />
                                  {t('settings.channels.add', 'Add')}
                                </Button>
                              </div>

                              {Object.keys(config.channels).length === 0 ? (
                                <p className="text-xs text-muted-foreground py-1">
                                  {t('settings.channels.noChannels', 'No channels configured. All channels will use guild settings.')}
                                </p>
                              ) : (
                                <div className="space-y-1">
                                  {Object.entries(config.channels).map(([chId, rule]) => (
                                    <div
                                      key={chId}
                                      className="flex items-center justify-between py-1.5 px-2 rounded bg-muted/30 text-xs"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <Hash className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                        <span className="font-mono truncate">{chId === '*' ? `* (${t('settings.channels.all', 'all')})` : chId}</span>
                                        <span className={cn(
                                          "px-1.5 py-0.5 rounded text-[10px] flex-shrink-0",
                                          rule.allow
                                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                                            : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
                                        )}>
                                          {rule.allow ? t('settings.channels.channelAllow', 'Allow') : t('permission.deny', 'Deny')}
                                        </span>
                                        {rule.requireMention !== undefined && (
                                          <span className="text-muted-foreground">
                                            @{rule.requireMention ? 'on' : 'off'}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-0.5 flex-shrink-0">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 w-6 p-0"
                                          onClick={() => {
                                            setEditingChannel({ guildId, channelId: chId, rule })
                                            setAddingChannelForGuild(null)
                                            setChannelDialogOpen(true)
                                          }}
                                        >
                                          <Edit2 className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                          onClick={() => setDeleteChannelConfirm({ guildId, channelId: chId })}
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
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Save Button */}
            <Button
              className="w-full gap-2"
              onClick={handleSave}
              disabled={isLoading}
            >
              {isLoading ? (
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

      {/* Guild Config Dialog */}
      <GuildConfigDialog
        open={guildDialogOpen}
        onOpenChange={setGuildDialogOpen}
        guild={editingGuild?.config}
        guildId={editingGuild?.id}
        onSave={editingGuild ? handleUpdateGuild : handleAddGuild}
      />

      {/* Delete Guild Confirmation */}
      <DeleteGuildDialog
        deleteGuildConfirm={deleteGuildConfirm}
        onClose={() => setDeleteGuildConfirm(null)}
        onDelete={handleDeleteGuild}
      />

      {/* Channel Config Dialog */}
      <ChannelConfigDialog
        open={channelDialogOpen}
        onOpenChange={setChannelDialogOpen}
        channel={editingChannel?.rule}
        channelId={editingChannel?.channelId}
        onSave={editingChannel ? handleUpdateChannel : handleAddChannel}
      />

      {/* Delete Channel Confirmation */}
      <DeleteChannelDialog
        deleteChannelConfirm={deleteChannelConfirm}
        onClose={() => setDeleteChannelConfirm(null)}
        onDelete={handleDeleteChannel}
      />

      {/* Setup Wizard */}
      <SetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onTokenSave={handleWizardTokenSave}
        existingToken={localConfig.token}
      />
    </>
  )
}
