import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Key, Shield, Loader2, ExternalLink, Bot, Sparkles, Plus } from 'lucide-react'
import { openExternalUrl } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChannelsStore } from '@/stores/channels-store'
import { type SeaTalkBot, type SeaTalkConfig, defaultSeaTalkConfig } from '@/stores/channels-types'
import { GatewayStatusCard } from './GatewayStatusCard'
import { TestCredentialsButton } from './TestCredentialsButton'
import { useChannelConfig } from '@/hooks/use-channel-config'
import { useShallow } from 'zustand/react/shallow'
import {
  botSecretPath,
  channelSecretPath,
  loadChannelSecretKeys,
} from '@/lib/team/channel-secret-presence'

function SeaTalkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.03 2 11c0 2.9 1.46 5.48 3.74 7.1L5 22l3.64-1.86C9.68 20.71 10.81 21 12 21c5.52 0 10-4.03 10-9S17.52 2 12 2zm0 16c-.95 0-1.87-.22-2.7-.63l-.3-.15-2.2 1.12.42-2.41-.2-.31C5.9 14.4 5 12.78 5 11c0-3.87 3.58-7 7-7s7 3.13 7 7-3.58 7-7 7z" />
    </svg>
  )
}

interface SeaTalkBotStatus {
  appId: string
  connected: boolean
  error?: string | null
}

function secretIsStored(appId: string, keys: Set<string>, onlyBot: boolean): boolean {
  const id = appId.trim()
  if (id && keys.has(botSecretPath('seatalk', id, 'app_secret'))) return true
  return onlyBot && keys.has(channelSecretPath('seatalk', 'app_secret'))
}

export function SeaTalkChannel() {
  const { t } = useTranslation()
  const {
    seatalk,
    seatalkIsLoading,
    seatalkGatewayStatus,
    seatalkHasChanges,
    seatalkIsTesting,
    seatalkTestResult,
    saveSeaTalkConfig,
    startSeaTalkGateway,
    stopSeaTalkGateway,
    refreshSeaTalkStatus,
    testSeaTalkCredentials,
    clearSeaTalkTestResult,
    setSeaTalkHasChanges,
    toggleSeaTalkEnabled,
  } = useChannelsStore(
    useShallow((s) => ({ seatalk: s.seatalk, seatalkIsLoading: s.seatalkIsLoading, seatalkGatewayStatus: s.seatalkGatewayStatus, seatalkHasChanges: s.seatalkHasChanges, seatalkIsTesting: s.seatalkIsTesting, seatalkTestResult: s.seatalkTestResult, saveSeaTalkConfig: s.saveSeaTalkConfig, startSeaTalkGateway: s.startSeaTalkGateway, stopSeaTalkGateway: s.stopSeaTalkGateway, refreshSeaTalkStatus: s.refreshSeaTalkStatus, testSeaTalkCredentials: s.testSeaTalkCredentials, clearSeaTalkTestResult: s.clearSeaTalkTestResult, setSeaTalkHasChanges: s.setSeaTalkHasChanges, toggleSeaTalkEnabled: s.toggleSeaTalkEnabled })),
  )

  const [expanded, setExpanded] = React.useState(false)
  const [secretKeys, setSecretKeys] = React.useState<Set<string>>(new Set())
  const [botStatuses, setBotStatuses] = React.useState<SeaTalkBotStatus[]>([])
  const [testingAppId, setTestingAppId] = React.useState<string | null>(null)

  const {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    isSaving,
    handleSave,
    handleRestart,
  } = useChannelConfig<SeaTalkConfig>({
    storeConfig: seatalk,
    defaultConfig: defaultSeaTalkConfig,
    gatewayStatus: seatalkGatewayStatus,
    isLoading: seatalkIsLoading,
    hasChanges: seatalkHasChanges,
    setHasChanges: setSeaTalkHasChanges,
    saveConfig: saveSeaTalkConfig,
    startGateway: startSeaTalkGateway,
    stopGateway: stopSeaTalkGateway,
    refreshStatus: refreshSeaTalkStatus,
  })

  const bots = localConfig.bots ?? []
  const filledIds = bots.filter((b) => b.appId.trim()).length

  React.useEffect(() => {
    let cancelled = false
    void loadChannelSecretKeys().then((keys) => {
      if (!cancelled) setSecretKeys(keys)
    })
    void invoke<SeaTalkBotStatus[]>('list_seatalk_bots_status')
      .then((rows) => {
        if (!cancelled) setBotStatuses(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (!cancelled) setBotStatuses([])
      })
    return () => {
      cancelled = true
    }
  }, [seatalkIsLoading, seatalkGatewayStatus.status, bots.length])

  const updateBot = (index: number, patch: Partial<SeaTalkBot>) => {
    updateLocalConfig({
      bots: bots.map((bot, i) => (i === index ? { ...bot, ...patch } : bot)),
    })
  }

  const canStart = bots.some(
    (bot) =>
      bot.enabled !== false &&
      Boolean(bot.appId.trim()) &&
      (Boolean(bot.appSecret.trim()) || secretIsStored(bot.appId, secretKeys, filledIds === 1)),
  )

  if (!seatalk) return null

  return (
    <GatewayStatusCard
      icon={
        <div className="rounded-md p-1.5 bg-sky-100 dark:bg-sky-900/50">
          <SeaTalkIcon className="h-4 w-4 text-sky-600 dark:text-sky-400" />
        </div>
      }
      title={t('settings.channels.seatalk.gateway', 'SeaTalk Gateway')}
      status={seatalkGatewayStatus.status}
      errorMessage={seatalkGatewayStatus.errorMessage}
      expanded={expanded}
      onToggleExpanded={() => setExpanded(!expanded)}
      enabled={localConfig.enabled}
      onToggleEnabled={(enabled) => {
        updateLocalConfig({ enabled })
        toggleSeaTalkEnabled(enabled, { ...localConfig, enabled })
      }}
      isLoading={seatalkIsLoading}
      isConnecting={isConnecting}
      isRunning={isRunning}
      hasChanges={seatalkHasChanges}
      onStart={startSeaTalkGateway}
      onStop={stopSeaTalkGateway}
      onRestart={handleRestart}
      startDisabled={!canStart}
    >
      {filledIds === 0 && (
        <div className="p-4 rounded-lg bg-gradient-to-br from-sky-50 to-blue-50 dark:from-sky-950/30 dark:to-blue-950/30 border border-sky-200 dark:border-sky-800">
          <div className="flex items-start gap-4">
            <Bot className="h-8 w-8 text-sky-600 dark:text-sky-400 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <h4 className="font-semibold text-sky-900 dark:text-sky-100">
                {t('settings.channels.seatalk.setupTitle', 'Set up SeaTalk Bot')}
              </h4>
              <p className="text-[13px] text-sky-700 dark:text-sky-300">
                {t(
                  'settings.channels.seatalk.setupDesc',
                  'Create a Bot App on SeaTalk Open Platform, enable WebSocket event delivery, then paste App ID and App Secret below.',
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => openExternalUrl('https://open.seatalk.io/')}
              >
                <ExternalLink className="h-4 w-4" />
                {t('settings.channels.seatalk.openPlatform', 'Open SeaTalk Open Platform')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[13px] font-medium flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            {t('settings.channels.seatalk.appCredentials', 'App Credentials')}
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() =>
              updateLocalConfig({
                bots: [...bots, { enabled: true, appId: '', appSecret: '' }],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.channels.seatalk.addBot', 'Add bot')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t(
            'settings.channels.seatalk.botsHint',
            'Each bot is its own SeaTalk app and its own connection. Group rules below apply to every bot.',
          )}
        </p>

        {bots.map((bot, index) => {
          const stored = secretIsStored(bot.appId, secretKeys, filledIds === 1)
          const status = botStatuses.find((row) => row.appId === bot.appId.trim())
          return (
            <div key={index} className="space-y-2 rounded-lg border border-border bg-paper p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">
                  {t('settings.channels.seatalk.botLabel', 'Bot {{index}}', { index: index + 1 })}
                </span>
                <div className="flex items-center gap-3">
                  {status?.error ? (
                    <span className="max-w-[220px] truncate text-[11px] text-destructive" title={status.error}>
                      {status.error}
                    </span>
                  ) : status ? (
                    <span className="text-[11px] font-mono text-faint">
                      {status.connected
                        ? t('settings.channels.seatalk.botConnected', 'Connected')
                        : t('settings.channels.seatalk.botDisconnected', 'Not connected')}
                    </span>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={bot.enabled !== false}
                      onChange={(e) => updateBot(index, { enabled: e.target.checked })}
                    />
                    {t('settings.channels.seatalk.botEnabled', 'Enabled')}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateLocalConfig({ bots: bots.filter((_, i) => i !== index) })}
                  >
                    {t('settings.channels.seatalk.removeBot', 'Remove')}
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('settings.channels.seatalk.appId', 'App ID')}</label>
                <Input
                  value={bot.appId}
                  onChange={(e) => updateBot(index, { appId: e.target.value })}
                  placeholder="your_app_id"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('settings.channels.seatalk.appSecret', 'App Secret')}</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type="password"
                      value={bot.appSecret}
                      onChange={(e) => updateBot(index, { appSecret: e.target.value })}
                      placeholder={
                        stored
                          ? t('settings.channels.seatalk.appSecretStored', 'Configured · leave empty to keep')
                          : t('settings.channels.seatalk.appSecretPlaceholder', 'Your app secret')
                      }
                      className="pr-10"
                    />
                    <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  </div>
                  <TestCredentialsButton
                    onTest={async () => {
                      setTestingAppId(bot.appId)
                      await testSeaTalkCredentials(bot.appId, bot.appSecret)
                    }}
                    isTesting={seatalkIsTesting && testingAppId === bot.appId}
                    testResult={testingAppId === bot.appId ? seatalkTestResult : null}
                    onClearResult={clearSeaTalkTestResult}
                    disabled={!bot.appId || !bot.appSecret}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[13px] font-medium">
                  {t('settings.channels.seatalk.systemPrompt', 'System prompt')}
                </label>
                <textarea
                  className="w-full min-h-[72px] rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
                  value={bot.systemPrompt ?? ''}
                  onChange={(e) => updateBot(index, { systemPrompt: e.target.value || undefined })}
                  placeholder={t(
                    'settings.channels.seatalk.systemPromptPlaceholder',
                    'Optional instructions this SeaTalk bot follows when it replies',
                  )}
                  rows={3}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t(
                    'settings.channels.seatalk.systemPromptHint',
                    'After you save, every reply from this bot includes this prompt.',
                  )}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      <div className="space-y-2">
        <label className="text-[13px] font-medium">
          {t('settings.channels.seatalk.groupPolicy', 'Group @bot policy')}
        </label>
        <select
          className="w-full h-9 rounded-md border border-border bg-paper px-3 text-[13px]"
          value={localConfig.groupPolicy}
          onChange={(e) => updateLocalConfig({ groupPolicy: e.target.value })}
        >
          <option value="open">
            {t('settings.channels.seatalk.groupPolicyOpen', 'Open — answer @bot in any group')}
          </option>
          <option value="allowlist">
            {t('settings.channels.seatalk.groupPolicyAllowlist', 'Allowlist — only listed group IDs')}
          </option>
          <option value="disabled">
            {t('settings.channels.seatalk.groupPolicyDisabled', 'Disabled — ignore group mentions')}
          </option>
        </select>
        {localConfig.groupPolicy === 'allowlist' && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('settings.channels.seatalk.groupAllowFrom', 'Allowed group IDs (one per line)')}
            </label>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-border bg-paper px-3 py-2 text-[12px] font-mono"
              value={(localConfig.groupAllowFrom ?? []).join('\n')}
              onChange={(e) =>
                updateLocalConfig({
                  groupAllowFrom: e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="group_id_1&#10;group_id_2"
            />
          </div>
        )}
      </div>

      <div className="p-3 rounded-lg bg-muted/40 text-[13px] space-y-1">
        <p className="font-medium">{t('settings.channels.seatalk.portalChecklist', 'SeaTalk portal checklist')}</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>{t('settings.channels.seatalk.checkBotOnline', 'Set Bot status to Online')}</li>
          <li>{t('settings.channels.seatalk.checkWebSocket', 'Event delivery: WebSocket mode')}</li>
          <li>{t('settings.channels.seatalk.checkMentionEvent', 'Subscribe: new_mentioned_message_received_from_group_chat')}</li>
          <li>{t('settings.channels.seatalk.checkThreadEvent', 'Subscribe: new_message_received_from_thread')}</li>
          <li>{t('settings.channels.seatalk.checkDmEvent', 'Subscribe: message_from_bot_subscriber (for DMs)')}</li>
          <li>{t('settings.channels.seatalk.checkSendGroup', 'Permission: Send Message to Group Chat (required to reply)')}</li>
          <li>{t('settings.channels.seatalk.checkSendDm', 'Permission: Send Message to Bot User (for DMs)')}</li>
          <li>{t('settings.channels.seatalk.checkAddToGroup', 'Add the bot to your target group')}</li>
          <li>{t('settings.channels.seatalk.checkStartGateway', 'Start the gateway below, then Re-verify WebSocket in the portal')}</li>
        </ul>
      </div>

      <Button className="w-full gap-2" onClick={handleSave} disabled={seatalkIsLoading || isSaving}>
        {seatalkIsLoading || isSaving ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.channels.saving', 'Saving...')}
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" />
            {t('settings.channels.saveChanges', 'Save Changes')}
          </>
        )}
      </Button>
    </GatewayStatusCard>
  )
}
