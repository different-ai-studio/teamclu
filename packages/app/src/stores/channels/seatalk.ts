import { invoke } from '@tauri-apps/api/core'
import type {
  SeaTalkConfig,
  SeaTalkGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultSeaTalkConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): SeaTalkGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'seatalk')
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

function describe(e: unknown): string {
  if (e instanceof AmuxdUnreachableError) return 'amuxd not running. Start amuxd and try again.'
  return e instanceof Error ? e.message : String(e)
}

export function createSeaTalkActions(set: ChannelsSet) {
  return {
    loadSeaTalkConfig: async () => {
      set({ seatalkIsLoading: true, error: null })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<SeaTalkConfig>('seatalk'),
        ])
        set({
          seatalk: { ...defaultSeaTalkConfig, ...storedConfig },
          seatalkGatewayStatus: statusFor(list),
          seatalkIsLoading: false,
          seatalkHasChanges: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          seatalkIsLoading: false,
        })
      }
    },

    saveSeaTalkConfig: async (config: SeaTalkConfig) => {
      set({ seatalkIsLoading: true, error: null })
      try {
        await saveChannelConfig('seatalk', config)
        await reloadChannels()
        set({
          seatalk: config,
          seatalkIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          seatalkIsLoading: false,
        })
        throw error
      }
    },

    startSeaTalkGateway: async () => {
      set({ seatalkIsLoading: true, error: null })
      try {
        let cfg: SeaTalkConfig = defaultSeaTalkConfig
        set((state) => {
          cfg = state.seatalk ?? defaultSeaTalkConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('seatalk', enabled)
        await reloadChannels()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({
          seatalk: enabled,
          seatalkGatewayStatus: statusFor(list),
          seatalkIsLoading: false,
          seatalkHasChanges: false,
        })
      } catch (error) {
        const errorMessage = describe(error)
        set({
          error: errorMessage,
          seatalkIsLoading: false,
          seatalkGatewayStatus: {
            status: 'error',
            errorMessage,
          },
        })
        throw error
      }
    },

    stopSeaTalkGateway: async () => {
      set({ seatalkIsLoading: true, error: null })
      try {
        let cfg: SeaTalkConfig = defaultSeaTalkConfig
        set((state) => {
          cfg = state.seatalk ?? defaultSeaTalkConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('seatalk', disabled)
        await reloadChannels()
        set({
          seatalk: disabled,
          seatalkGatewayStatus: { status: 'disconnected' },
          seatalkIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          seatalkIsLoading: false,
        })
        throw error
      }
    },

    refreshSeaTalkStatus: async () => {
      try {
        const list = await listChannels()
        set({ seatalkGatewayStatus: statusFor(list) })
      } catch (error) {
        console.error('Failed to refresh SeaTalk gateway status:', error)
      }
    },

    testSeaTalkCredentials: async (appId: string, appSecret: string) => {
      set({ seatalkIsTesting: true, seatalkTestResult: null, error: null })
      try {
        const message = await invoke<string>('test_seatalk_credentials', {
          appId,
          appSecret,
        })
        set({
          seatalkIsTesting: false,
          seatalkTestResult: { success: true, message },
        })
        return true
      } catch (error) {
        const message = describe(error)
        set({
          seatalkIsTesting: false,
          seatalkTestResult: { success: false, message },
        })
        return false
      }
    },

    clearSeaTalkTestResult: () => set({ seatalkTestResult: null }),
    setSeaTalkHasChanges: (hasChanges: boolean) => set({ seatalkHasChanges: hasChanges }),

    toggleSeaTalkEnabled: async (enabled: boolean, config: SeaTalkConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('seatalk', updatedConfig)
        await reloadChannels()
        set({ seatalk: updatedConfig, seatalkHasChanges: false })
        if (enabled) {
          set({ seatalkIsLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ seatalkGatewayStatus: statusFor(list), seatalkIsLoading: false })
          } catch (error) {
            console.error('[SeaTalk] Status check after toggle failed:', error)
            set({ seatalkIsLoading: false, error: describe(error) })
          }
        } else {
          set({ seatalkGatewayStatus: { status: 'disconnected' } })
        }
      } catch (error) {
        console.error('[SeaTalk] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
