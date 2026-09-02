/**
 * useChannelConfig - Generic hook that wraps common channel store patterns.
 * Reduces boilerplate in each channel component for:
 * - Local config state synced with store
 * - Gateway status polling when connected
 * - Start/stop/restart gateway logic
 * - Save with hasChanges tracking
 */
import * as React from 'react'
import { toast } from 'sonner'
import i18n from '@/lib/i18n'

interface GatewayStatusLike {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

interface UseChannelConfigOptions<TConfig> {
  /** Current config from the store (may be null if not loaded) */
  storeConfig: TConfig | null
  /** Default config value */
  defaultConfig: TConfig
  /** Gateway status object from the store */
  gatewayStatus: GatewayStatusLike
  /** Whether the store is in a loading state */
  isLoading: boolean
  /** Whether there are unsaved changes that need a restart */
  hasChanges: boolean
  /** Set the hasChanges flag in the store */
  setHasChanges: (v: boolean) => void
  /** Save config to the store/backend */
  saveConfig: (config: TConfig) => Promise<void>
  /** Start the gateway */
  startGateway: () => Promise<void>
  /** Stop the gateway */
  stopGateway: () => Promise<void>
  /** Refresh gateway status (called on interval when connected) */
  refreshStatus: () => void
  /** Optional: toggle enabled state (some channels have a quick toggle) */
  toggleEnabled?: (enabled: boolean, config: TConfig) => void
}

interface UseChannelConfigResult<TConfig> {
  /** Local config state (editable copy) */
  localConfig: TConfig
  /** Update fields on the local config */
  updateLocalConfig: (updates: Partial<TConfig>) => void
  /** Whether the gateway is currently connecting */
  isConnecting: boolean
  /** Whether the gateway is running (connected or connecting) */
  isRunning: boolean
  /** Whether a save started from `handleSave` is still in flight */
  isSaving: boolean
  /** Save config to the backend */
  handleSave: () => Promise<void>
  /** Start or stop the gateway */
  handleStartStop: () => Promise<void>
  /** Restart: stop, save, start */
  handleRestart: () => Promise<void>
}

export function useChannelConfig<TConfig extends object>(
  options: UseChannelConfigOptions<TConfig>
): UseChannelConfigResult<TConfig> {
  const {
    storeConfig,
    defaultConfig,
    gatewayStatus,
    setHasChanges,
    saveConfig,
    startGateway,
    stopGateway,
    refreshStatus,
  } = options

  const [localConfig, setLocalConfig] = React.useState<TConfig>(defaultConfig)
  const [isSaving, setIsSaving] = React.useState(false)

  // Sync local config with store
  React.useEffect(() => {
    if (storeConfig) {
      setLocalConfig(storeConfig)
    }
  }, [storeConfig])

  // Refresh status periodically when connected
  React.useEffect(() => {
    if (gatewayStatus.status === 'connected' || gatewayStatus.status === 'connecting') {
      const interval = setInterval(refreshStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [gatewayStatus.status, refreshStatus])

  const isConnecting = gatewayStatus.status === 'connecting'
  const isRunning = gatewayStatus.status === 'connected' || isConnecting

  const updateLocalConfig = React.useCallback((updates: Partial<TConfig>) => {
    setLocalConfig(prev => ({ ...prev, ...updates }))
  }, [])

  // Saving used to be entirely silent: no toast on success, and the failure
  // toast could not fire because the stores swallowed their own errors. The
  // button just sat there either way, so "did that work?" had no answer.
  const handleSave = React.useCallback(async () => {
    setIsSaving(true)
    try {
      await saveConfig(localConfig)
      if (isRunning) {
        setHasChanges(true)
      }
      toast.success(i18n.t('settings.channels.saveSuccess', 'Changes saved'))
    } catch (err) {
      toast.error(i18n.t('settings.channels.saveError', 'Failed to save changes'), {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setIsSaving(false)
    }
  }, [localConfig, isRunning, saveConfig, setHasChanges])

  const handleStartStop = React.useCallback(async () => {
    try {
      if (gatewayStatus.status === 'connected' || gatewayStatus.status === 'connecting') {
        await stopGateway()
      } else {
        await saveConfig(localConfig)
        await startGateway()
      }
    } catch {
      // Error is handled by the store
    }
  }, [gatewayStatus.status, localConfig, saveConfig, startGateway, stopGateway])

  const handleRestart = React.useCallback(async () => {
    await stopGateway()
    await saveConfig(localConfig)
    await startGateway()
    setHasChanges(false)
  }, [localConfig, saveConfig, startGateway, stopGateway, setHasChanges])

  return {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    isSaving,
    handleSave,
    handleStartStop,
    handleRestart,
  }
}
