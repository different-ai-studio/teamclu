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
  X,
  ChevronDown,
  ChevronRight,
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
  type KookConfig,
  type KookGuildConfig,
  type KookChannelRule,
  defaultKookConfig,
} from '@/stores/channels'
import { KookIcon, SettingCard, ToggleSwitch, StatusBadge } from './shared'
import {
  KookSetupWizard,
  KookGuildConfigDialog,
  KookChannelConfigDialog,
  KookDeleteGuildDialog,
  KookDeleteChannelDialog,
} from './KookDialogs'
import { useShallow } from 'zustand/react/shallow'

export function KookChannel() {
  const { t } = useTranslation()
  const {
    kook,
    kookIsLoading,
    kookGatewayStatus,
    kookHasChanges,
    kookIsTesting,
    kookTestResult,
    saveKookConfig,
    startKookGateway,
    stopKookGateway,
    testKookToken,
    clearKookTestResult,
    setKookHasChanges,
  } = useChannelsStore(
    useShallow((s) => ({ kook: s.kook, kookIsLoading: s.kookIsLoading, kookGatewayStatus: s.kookGatewayStatus, kookHasChanges: s.kookHasChanges, kookIsTesting: s.kookIsTesting, kookTestResult: s.kookTestResult, saveKookConfig: s.saveKookConfig, startKookGateway: s.startKookGateway, stopKookGateway: s.stopKookGateway, testKookToken: s.testKookToken, clearKookTestResult: s.clearKookTestResult, setKookHasChanges: s.setKookHasChanges })),
  )

  const [kookExpanded, setKookExpanded] = React.useState(false)
  const [kookWizardOpen, setKookWizardOpen] = React.useState(false)
  const [kookLocalConfig, setKookLocalConfig] = React.useState<KookConfig>(defaultKookConfig)
  const [kookGuildDialogOpen, setKookGuildDialogOpen] = React.useState(false)
  const [kookEditingGuild, setKookEditingGuild] = React.useState<{ id: string; config: KookGuildConfig } | null>(null)
  const [kookExpandedGuilds, setKookExpandedGuilds] = React.useState<Set<string>>(new Set())
  const [kookDeleteGuildConfirm, setKookDeleteGuildConfirm] = React.useState<string | null>(null)
  const [kookChannelDialogOpen, setKookChannelDialogOpen] = React.useState(false)
  const [kookEditingChannel, setKookEditingChannel] = React.useState<{
    guildId: string
    channelId: string
    rule: KookChannelRule
  } | null>(null)
  const [kookAddingChannelForGuild, setKookAddingChannelForGuild] = React.useState<string | null>(null)
  const [kookDeleteChannelConfirm, setKookDeleteChannelConfirm] = React.useState<{
    guildId: string
    channelId: string
  } | null>(null)

  // KOOK: sync local state with store
  React.useEffect(() => {
    if (kook) {
      setKookLocalConfig(kook)
    }
  }, [kook])

  const updateKookLocalConfig = (updates: Partial<KookConfig>) => {
    setKookLocalConfig(prev => ({ ...prev, ...updates }))
  }

  const handleKookSave = async () => {
    try {
      await saveKookConfig(kookLocalConfig)
      if (kookIsRunning) {
        setKookHasChanges(true)
      }
    } catch (error) {
      console.error('[KOOK] Save failed:', error)
    }
  }

  const handleKookWizardSave = (token: string) => {
    setKookLocalConfig(prev => ({ ...prev, token, enabled: true }))
  }

  const handleKookAddGuild = (guildId: string, config: KookGuildConfig) => {
    setKookLocalConfig(prev => ({
      ...prev,
      guilds: { ...prev.guilds, [guildId]: config },
    }))
  }

  const handleKookUpdateGuild = (guildId: string, config: KookGuildConfig) => {
    setKookLocalConfig(prev => ({
      ...prev,
      guilds: { ...prev.guilds, [guildId]: config },
    }))
  }

  const handleKookDeleteGuild = (guildId: string) => {
    setKookLocalConfig(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [guildId]: _, ...rest } = prev.guilds
      return { ...prev, guilds: rest }
    })
    setKookDeleteGuildConfirm(null)
  }

  const handleKookAddChannel = (channelId: string, rule: KookChannelRule) => {
    if (!kookAddingChannelForGuild) return
    const guildId = kookAddingChannelForGuild
    setKookLocalConfig(prev => ({
      ...prev,
      guilds: {
        ...prev.guilds,
        [guildId]: {
          ...prev.guilds[guildId],
          channels: { ...prev.guilds[guildId].channels, [channelId]: rule },
        },
      },
    }))
    setKookAddingChannelForGuild(null)
  }

  const handleKookUpdateChannel = (channelId: string, rule: KookChannelRule) => {
    if (!kookEditingChannel) return
    const guildId = kookEditingChannel.guildId
    setKookLocalConfig(prev => ({
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

  const handleKookDeleteChannel = (guildId: string, channelId: string) => {
    setKookLocalConfig(prev => {
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
    setKookDeleteChannelConfirm(null)
  }

  const toggleKookGuildExpand = (guildId: string) => {
    setKookExpandedGuilds(prev => {
      const next = new Set(prev)
      if (next.has(guildId)) {
        next.delete(guildId)
      } else {
        next.add(guildId)
      }
      return next
    })
  }

  const kookIsConnecting = kookGatewayStatus.status === 'connecting'
  const kookIsRunning = kookGatewayStatus.status === 'connected' || kookIsConnecting

  if (!kook) return null

  return (
    <>
      <SettingCard className="!p-3">
        {/* Header Row - always visible */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setKookExpanded(!kookExpanded)}
            className="flex items-center gap-3 flex-1 text-left"
          >
            <div className="rounded-md p-1.5 bg-blue-100 dark:bg-blue-900/50">
              <KookIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{t('settings.channels.kook.gateway', 'KOOK Gateway')}</span>
                <StatusBadge status={kookGatewayStatus.status} />
              </div>
              {kookGatewayStatus.botUsername && (
                <p className="text-xs text-muted-foreground">
                  @{kookGatewayStatus.botUsername}
                </p>
              )}
              {kookGatewayStatus.errorMessage && (
                <p className="text-xs text-red-500">{kookGatewayStatus.errorMessage}</p>
              )}
            </div>
            {kookExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setKookWizardOpen(true)}
              className="h-7 w-7 p-0"
              title={t('settings.channels.startSetup', 'Start Setup')}
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </Button>
            <ToggleSwitch
              enabled={kookLocalConfig.enabled}
              onChange={async (enabled) => {
                updateKookLocalConfig({ enabled })
                if (enabled && !kookIsRunning) {
                  await saveKookConfig({ ...kookLocalConfig, enabled })
                  await startKookGateway()
                } else if (!enabled && kookIsRunning) {
                  await stopKookGateway()
                }
              }}
              disabled={kookIsLoading || kookIsConnecting}
            />
            {kookHasChanges && kookIsRunning && (
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  await stopKookGateway()
                  await saveKookConfig(kookLocalConfig)
                  await startKookGateway()
                  setKookHasChanges(false)
                }}
                disabled={kookIsLoading || kookIsConnecting}
                className="h-7 gap-1.5 px-2.5 text-[12px]"
              >
                {kookIsLoading || kookIsConnecting ? (
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
        {kookExpanded && (
          <div className="mt-4 pt-4 border-t space-y-6">
            {/* No token prompt */}
            {!kookLocalConfig.token && (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <KookIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                <div className="flex-1">
                  <p className="text-[13px] font-medium">{t('settings.channels.kook.noToken', 'No KOOK bot token configured')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.kook.noTokenHint', 'Use the setup wizard to configure your KOOK bot.')}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setKookWizardOpen(true)}>
                  {t('settings.channels.setup', 'Setup')}
                </Button>
              </div>
            )}

            {/* Bot Token */}
            <div className="space-y-2">
              <label className="text-[13px] font-medium flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                {t('settings.channels.kook.botToken', 'Bot Token')}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="password"
                    value={kookLocalConfig.token}
                    onChange={(e) => {
                      updateKookLocalConfig({ token: e.target.value })
                    }}
                    placeholder={t('settings.channels.kook.botTokenPlaceholder', 'Your KOOK bot token')}
                    className="pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await testKookToken(kookLocalConfig.token)
                  }}
                  disabled={kookIsTesting || !kookLocalConfig.token}
                >
                  {kookIsTesting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('settings.channels.test', 'Test')
                  )}
                </Button>
              </div>
              {kookTestResult && (
                <div className={cn(
                  "flex items-center gap-2 text-[13px]",
                  kookTestResult.success ? "text-emerald-600" : "text-red-600"
                )}>
                  {kookTestResult.success ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {kookTestResult.message}
                  <Button variant="ghost" size="sm" className="h-4 w-4 p-0" onClick={clearKookTestResult}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" />
                {t('settings.channels.tokenStoredLocally', 'Your token is stored locally and never sent to our servers.')}
              </p>
            </div>

            {/* DM Configuration */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-medium flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                {t('settings.channels.directMessages', 'Direct Messages')}
              </h4>

              <div className="pl-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-[13px] font-medium">{t('settings.channels.enableDMs', 'Enable DMs')}</label>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.channels.enableDMsDesc', 'Allow users to message the bot directly')}
                    </p>
                  </div>
                  <ToggleSwitch
                    enabled={kookLocalConfig.dm.enabled}
                    onChange={(enabled) => {
                      updateKookLocalConfig({
                        dm: { ...kookLocalConfig.dm, enabled }
                      })
                    }}
                  />
                </div>

                {kookLocalConfig.dm.enabled && (
                  <>
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium">{t('settings.channels.accessPolicy', 'Access Policy')}</label>
                      <Select
                        value={kookLocalConfig.dm.policy}
                        onValueChange={(policy: 'open' | 'allowlist') => {
                          updateKookLocalConfig({
                            dm: { ...kookLocalConfig.dm, policy }
                          })
                        }}
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

                    {kookLocalConfig.dm.policy === 'allowlist' && (
                      <div className="space-y-2">
                        <label className="text-[13px] font-medium">{t('settings.channels.allowedUsers', 'Allowed Users')}</label>
                        <Input
                          value={kookLocalConfig.dm.allowFrom.join(', ')}
                          onChange={(e) => {
                            const users = e.target.value
                              .split(',')
                              .map(s => s.trim())
                              .filter(s => s.length > 0)
                            updateKookLocalConfig({
                              dm: { ...kookLocalConfig.dm, allowFrom: users }
                            })
                          }}
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

            {/* Server Settings */}
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
                    setKookEditingGuild(null)
                    setKookGuildDialogOpen(true)
                  }}
                  className="gap-2 h-7 text-xs"
                >
                  <Plus className="h-3 w-3" />
                  {t('settings.channels.addServer', 'Add Server')}
                </Button>
              </div>

              <div className="pl-6">
                {Object.keys(kookLocalConfig.guilds).length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-[13px] font-medium">{t('settings.channels.noServers', 'No servers configured')}</p>
                    <p className="text-xs">{t('settings.channels.noServersHint', 'Add a server to allow the bot to respond in server channels')}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(kookLocalConfig.guilds).map(([guildId, guild]) => (
                      <div
                        key={guildId}
                        className="border rounded-lg p-3"
                      >
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => toggleKookGuildExpand(guildId)}
                            className="flex items-center gap-2 text-left flex-1"
                          >
                            {kookExpandedGuilds.has(guildId) ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            <Hash className="h-4 w-4 text-orange-500" />
                            <span className="text-[13px] font-medium">{guild.slug || guildId}</span>
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
                                setKookEditingGuild({ id: guildId, config: guild })
                                setKookGuildDialogOpen(true)
                              }}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              onClick={() => setKookDeleteGuildConfirm(guildId)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        {kookExpandedGuilds.has(guildId) && (
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
                                    setKookAddingChannelForGuild(guildId)
                                    setKookEditingChannel(null)
                                    setKookChannelDialogOpen(true)
                                  }}
                                >
                                  <Plus className="h-3 w-3" />
                                  {t('settings.channels.add', 'Add')}
                                </Button>
                              </div>

                              {Object.keys(guild.channels).length === 0 ? (
                                <p className="text-xs text-muted-foreground py-1">
                                  {t('settings.channels.noChannelsHint', 'No channels configured. All channels will use server settings.')}
                                </p>
                              ) : (
                                <div className="space-y-1">
                                  {Object.entries(guild.channels).map(([chId, rule]) => (
                                    <div
                                      key={chId}
                                      className="flex items-center justify-between py-1.5 px-2 rounded bg-muted/30 text-xs"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <Hash className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                        <span className="font-mono truncate">{chId === '*' ? `* (${t('settings.channels.all', 'all')})` : chId}</span>
                                        <span className={cn(
                                          "px-1.5 py-0.5 rounded text-[10px] flex-shrink-0",
                                          rule.enabled
                                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                                            : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
                                        )}>
                                          {rule.enabled ? t('settings.channels.enabled', 'enabled') : t('settings.channels.disabled', 'disabled')}
                                        </span>
                                        {rule.requireMention && (
                                          <span className="text-muted-foreground">@on</span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-0.5 flex-shrink-0">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 w-6 p-0"
                                          onClick={() => {
                                            setKookEditingChannel({ guildId, channelId: chId, rule })
                                            setKookAddingChannelForGuild(null)
                                            setKookChannelDialogOpen(true)
                                          }}
                                        >
                                          <Edit2 className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                          onClick={() => setKookDeleteChannelConfirm({ guildId, channelId: chId })}
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
              onClick={handleKookSave}
              disabled={kookIsLoading}
            >
              {kookIsLoading ? (
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

      {/* KOOK Setup Wizard */}
      <KookSetupWizard
        open={kookWizardOpen}
        onOpenChange={setKookWizardOpen}
        onTokenSave={handleKookWizardSave}
        existingToken={kookLocalConfig.token}
      />

      {/* KOOK Guild Config Dialog */}
      <KookGuildConfigDialog
        open={kookGuildDialogOpen}
        onOpenChange={setKookGuildDialogOpen}
        guild={kookEditingGuild?.config}
        guildId={kookEditingGuild?.id}
        onSave={kookEditingGuild ? handleKookUpdateGuild : handleKookAddGuild}
      />

      {/* KOOK Delete Guild Confirmation */}
      <KookDeleteGuildDialog
        deleteGuildConfirm={kookDeleteGuildConfirm}
        onClose={() => setKookDeleteGuildConfirm(null)}
        onDelete={handleKookDeleteGuild}
      />

      {/* KOOK Channel Config Dialog */}
      <KookChannelConfigDialog
        open={kookChannelDialogOpen}
        onOpenChange={setKookChannelDialogOpen}
        channel={kookEditingChannel?.rule}
        channelId={kookEditingChannel?.channelId}
        onSave={kookEditingChannel ? handleKookUpdateChannel : handleKookAddChannel}
      />

      {/* KOOK Delete Channel Confirmation */}
      <KookDeleteChannelDialog
        deleteChannelConfirm={kookDeleteChannelConfirm}
        onClose={() => setKookDeleteChannelConfirm(null)}
        onDelete={handleKookDeleteChannel}
      />
    </>
  )
}
