import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, Server, ShieldCheck, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChannelsStore } from '@/stores/channels-store'
import { type WeChatPadConfig, defaultWeChatPadConfig } from '@/stores/channels-types'
import { WeChatIcon } from './shared'
import { GatewayStatusCard } from './GatewayStatusCard'
import { useChannelConfig } from '@/hooks/use-channel-config'
import { ChannelRuntimeOptions } from './ChannelRuntimeOptions'
import { inheritedRuntime, pinChannelRuntime } from './channel-runtime'
import { useChannelRuntimeDefaults } from './use-channel-runtime-defaults'
import { useShallow } from 'zustand/react/shallow'

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Personal WeChat through a self-hosted iPad-protocol server. The server runs
 * beside amuxd and holds the account's login; this panel only points the
 * daemon at it and says who may talk to the agent.
 */
export function WeChatPadChannel() {
  const { t } = useTranslation()
  const {
    wechatpad,
    wechatpadIsLoading,
    wechatpadGatewayStatus,
    wechatpadHasChanges,
    loadWechatpadConfig,
    saveWechatpadConfig,
    startWechatpadGateway,
    stopWechatpadGateway,
    refreshWechatpadStatus,
    setWechatpadHasChanges,
    toggleWechatpadEnabled,
  } = useChannelsStore(
    useShallow((s) => ({
      wechatpad: s.wechatpad,
      wechatpadIsLoading: s.wechatpadIsLoading,
      wechatpadGatewayStatus: s.wechatpadGatewayStatus,
      wechatpadHasChanges: s.wechatpadHasChanges,
      loadWechatpadConfig: s.loadWechatpadConfig,
      saveWechatpadConfig: s.saveWechatpadConfig,
      startWechatpadGateway: s.startWechatpadGateway,
      stopWechatpadGateway: s.stopWechatpadGateway,
      refreshWechatpadStatus: s.refreshWechatpadStatus,
      setWechatpadHasChanges: s.setWechatpadHasChanges,
      toggleWechatpadEnabled: s.toggleWechatpadEnabled,
    })),
  )

  const [expanded, setExpanded] = React.useState(false)
  const runtimeDefaults = useChannelRuntimeDefaults()

  React.useEffect(() => {
    loadWechatpadConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    isSaving,
    handleSave,
    handleRestart,
  } = useChannelConfig<WeChatPadConfig>({
    storeConfig: wechatpad,
    defaultConfig: defaultWeChatPadConfig,
    gatewayStatus: wechatpadGatewayStatus,
    isLoading: wechatpadIsLoading,
    hasChanges: wechatpadHasChanges,
    setHasChanges: setWechatpadHasChanges,
    saveConfig: saveWechatpadConfig,
    startGateway: startWechatpadGateway,
    stopGateway: stopWechatpadGateway,
    refreshStatus: refreshWechatpadStatus,
    prepareConfig: (config) => pinChannelRuntime(config, inheritedRuntime(runtimeDefaults)),
  })

  const update = (patch: Partial<WeChatPadConfig>) => {
    updateLocalConfig(patch)
    setWechatpadHasChanges(true)
  }

  const hasAccount = Boolean(localConfig.accountWxid.trim())
  const nobodyAllowed = localConfig.dmPolicy === 'allowlist' && localConfig.allowFrom.length === 0

  return (
    <GatewayStatusCard
      icon={
        <div className="rounded-md p-1.5 bg-green-100 dark:bg-green-900/50">
          <WeChatIcon className="h-4 w-4" />
        </div>
      }
      title={t('settings.channels.wechatpad.gateway', 'WeChat (iPad protocol)')}
      status={wechatpadGatewayStatus.status}
      statusDetail={
        hasAccount ? (
          <p className="text-[13px] text-muted-foreground">
            {t('settings.channels.wechatpad.account', 'Account')}: {localConfig.accountWxid}
          </p>
        ) : undefined
      }
      errorMessage={wechatpadGatewayStatus.errorMessage}
      expanded={expanded}
      onToggleExpanded={() => setExpanded(!expanded)}
      enabled={localConfig.enabled}
      onToggleEnabled={(enabled) => {
        const next = pinChannelRuntime({ ...localConfig, enabled }, inheritedRuntime(runtimeDefaults))
        updateLocalConfig(next)
        toggleWechatpadEnabled(enabled, next)
      }}
      isLoading={wechatpadIsLoading}
      isConnecting={isConnecting}
      isRunning={isRunning}
      hasChanges={wechatpadHasChanges}
      onStart={startWechatpadGateway}
      onStop={stopWechatpadGateway}
      onRestart={handleRestart}
      startDisabled={!hasAccount}
    >
      <div className="p-3 rounded-lg bg-muted/40 text-[13px] space-y-1">
        <p className="font-medium">
          {t('settings.channels.wechatpad.setupTitle', 'Before you start')}
        </p>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>
            {t(
              'settings.channels.wechatpad.setupServer',
              'Run the protocol server: deploy/wechatpad/docker-compose.yml',
            )}
          </li>
          <li>
            {t(
              'settings.channels.wechatpad.setupLogin',
              'Log a secondary account in: scripts/wechatpad-login.py prints the account wxid',
            )}
          </li>
          <li>
            {t(
              'settings.channels.wechatpad.setupRisk',
              'The protocol is unofficial and accounts on it can be restricted — never use your main account',
            )}
          </li>
        </ul>
      </div>

      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          {t('settings.channels.wechatpad.server', 'Protocol server')}
        </label>
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('settings.channels.wechatpad.serverUrl', 'Server URL')}
            </label>
            <Input
              value={localConfig.serverUrl}
              onChange={(e) => update({ serverUrl: e.target.value })}
              placeholder="http://127.0.0.1:3010"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('settings.channels.wechatpad.callbackPort', 'Callback port')}
            </label>
            <Input
              type="number"
              value={localConfig.callbackPort}
              onChange={(e) => update({ callbackPort: Number(e.target.value) || 0 })}
              placeholder="9101"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {t('settings.channels.wechatpad.accountWxid', 'Account wxid')}
          </label>
          <Input
            value={localConfig.accountWxid}
            onChange={(e) => update({ accountWxid: e.target.value })}
            placeholder="wxid_…"
            className="font-mono"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          {t('settings.channels.wechatpad.access', 'Who can talk to the agent')}
        </label>
        <select
          className="w-full h-9 rounded-md border border-border bg-paper px-3 text-[13px]"
          value={localConfig.dmPolicy}
          onChange={(e) => update({ dmPolicy: e.target.value as WeChatPadConfig['dmPolicy'] })}
        >
          <option value="allowlist">
            {t('settings.channels.wechatpad.dmAllowlist', 'Allowlist — only the wxids below')}
          </option>
          <option value="open">
            {t('settings.channels.wechatpad.dmOpen', 'Open — anyone who messages the account')}
          </option>
        </select>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {t('settings.channels.wechatpad.allowFrom', 'Allowed wxids (one per line)')}
          </label>
          <textarea
            className="w-full min-h-[72px] rounded-md border border-border bg-paper px-3 py-2 text-[12px] font-mono"
            value={localConfig.allowFrom.join('\n')}
            onChange={(e) => update({ allowFrom: lines(e.target.value) })}
            placeholder="wxid_…"
          />
          {nobodyAllowed && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {t(
                'settings.channels.wechatpad.nobodyAllowed',
                'Nobody is on the list yet, so the agent will not answer anyone.',
              )}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          {t('settings.channels.wechatpad.groupPolicy', 'Groups')}
        </label>
        <select
          className="w-full h-9 rounded-md border border-border bg-paper px-3 text-[13px]"
          value={localConfig.groupPolicy}
          onChange={(e) => update({ groupPolicy: e.target.value as WeChatPadConfig['groupPolicy'] })}
        >
          <option value="allowlist">
            {t(
              'settings.channels.wechatpad.groupAllowlist',
              'Allowlist — allowed wxids, in the groups below (empty = any group)',
            )}
          </option>
          <option value="open">
            {t('settings.channels.wechatpad.groupOpen', 'Open — anyone in any group')}
          </option>
          <option value="disabled">
            {t('settings.channels.wechatpad.groupDisabled', 'Disabled — ignore groups')}
          </option>
        </select>
        {localConfig.groupPolicy === 'allowlist' && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('settings.channels.wechatpad.groupAllowFrom', 'Allowed groups (…@chatroom, one per line)')}
            </label>
            <textarea
              className="w-full min-h-[56px] rounded-md border border-border bg-paper px-3 py-2 text-[12px] font-mono"
              value={localConfig.groupAllowFrom.join('\n')}
              onChange={(e) => update({ groupAllowFrom: lines(e.target.value) })}
              placeholder="12345678@chatroom"
            />
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t(
            'settings.channels.wechatpad.groupHint',
            'In a group the agent answers an @mention, a /command, or a quote of its own message.',
          )}
        </p>
      </div>

      <ChannelRuntimeOptions
        workspaceId={localConfig.workspaceId}
        model={localConfig.model}
        workspaces={runtimeDefaults.workspaces}
        models={runtimeDefaults.models}
        inheritedWorkspaceId={runtimeDefaults.inheritedWorkspaceId}
        inheritedModel={runtimeDefaults.inheritedModel}
        onChange={update}
      />

      <Button className="w-full gap-2" onClick={handleSave} disabled={wechatpadIsLoading || isSaving}>
        {wechatpadIsLoading || isSaving ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.channels.saving', 'Saving...')}
          </>
        ) : (
          t('settings.channels.saveChanges', 'Save Changes')
        )}
      </Button>
    </GatewayStatusCard>
  )
}
