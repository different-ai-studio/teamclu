import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Key, Shield, Loader2, ExternalLink, Bot, Sparkles } from 'lucide-react'
import { openExternalUrl } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useChannelsStore,
  type SeaTalkConfig,
  defaultSeaTalkConfig,
} from '@/stores/channels'
import { GatewayStatusCard } from './GatewayStatusCard'
import { TestCredentialsButton } from './TestCredentialsButton'
import { useChannelConfig } from '@/hooks/useChannelConfig'

function SeaTalkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.03 2 11c0 2.9 1.46 5.48 3.74 7.1L5 22l3.64-1.86C9.68 20.71 10.81 21 12 21c5.52 0 10-4.03 10-9S17.52 2 12 2zm0 16c-.95 0-1.87-.22-2.7-.63l-.3-.15-2.2 1.12.42-2.41-.2-.31C5.9 14.4 5 12.78 5 11c0-3.87 3.58-7 7-7s7 3.13 7 7-3.58 7-7 7z" />
    </svg>
  )
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
  } = useChannelsStore()

  const [expanded, setExpanded] = React.useState(false)

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

  const handleTestCredentials = async () => {
    if (!localConfig.appId || !localConfig.appSecret) return
    await testSeaTalkCredentials(localConfig.appId, localConfig.appSecret)
  }

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
      statusDetail={
        seatalkGatewayStatus.appId ? (
          <p className="text-xs text-muted-foreground">App: {seatalkGatewayStatus.appId}</p>
        ) : undefined
      }
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
      startDisabled={!localConfig.appId || !localConfig.appSecret}
    >
      {!localConfig.appId && (
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

      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          {t('settings.channels.seatalk.appCredentials', 'App Credentials')}
        </label>
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('settings.channels.seatalk.appId', 'App ID')}</label>
            <Input
              value={localConfig.appId}
              onChange={(e) => updateLocalConfig({ appId: e.target.value })}
              placeholder="your_app_id"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('settings.channels.seatalk.appSecret', 'App Secret')}</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type="password"
                  value={localConfig.appSecret}
                  onChange={(e) => updateLocalConfig({ appSecret: e.target.value })}
                  placeholder={t('settings.channels.seatalk.appSecretPlaceholder', 'Your app secret')}
                  className="pr-10"
                />
                <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
              <TestCredentialsButton
                onTest={handleTestCredentials}
                isTesting={seatalkIsTesting}
                testResult={seatalkTestResult}
                onClearResult={clearSeaTalkTestResult}
                disabled={!localConfig.appId || !localConfig.appSecret}
              />
            </div>
          </div>
        </div>
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
