import type {
  KookConfig,
  KookGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultKookConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): KookGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'kook')
  if (!entry) return { status: 'disconnected', connectedGuilds: [] }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError, connectedGuilds: [] }
  if (entry.connected) return { status: 'connected', connectedGuilds: [] }
  if (entry.enabled) return { status: 'connecting', connectedGuilds: [] }
  return { status: 'disconnected', connectedGuilds: [] }
}

function describe(e: unknown): string {
  if (e instanceof AmuxdUnreachableError) return 'amuxd not running. Start amuxd and try again.'
  return e instanceof Error ? e.message : String(e)
}

export function createKookActions(set: ChannelsSet) {
  return {
    loadKookConfig: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<KookConfig>('kook'),
        ])
        set({
          kook: { ...defaultKookConfig, ...storedConfig },
          kookGatewayStatus: statusFor(list),
          kookIsLoading: false,
          kookHasChanges: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          kookIsLoading: false,
        })
      }
    },

    saveKookConfig: async (config: KookConfig) => {
      set({ kookIsLoading: true, error: null })
      try {
        await saveChannelConfig('kook', config)
        await reloadChannels()
        set({
          kook: config,
          kookIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          kookIsLoading: false,
        })
        throw error
      }
    },

    startKookGateway: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        let cfg: KookConfig = defaultKookConfig
        set((state) => {
          cfg = state.kook ?? defaultKookConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('kook', enabled)
        await reloadChannels()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({
          kook: enabled,
          kookGatewayStatus: statusFor(list),
          kookIsLoading: false,
          kookHasChanges: false,
        })
      } catch (error) {
        const errorMessage = describe(error)
        set({
          error: errorMessage,
          kookIsLoading: false,
          kookGatewayStatus: {
            status: 'error',
            errorMessage,
            connectedGuilds: [],
          },
        })
        throw error
      }
    },

    stopKookGateway: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        let cfg: KookConfig = defaultKookConfig
        set((state) => {
          cfg = state.kook ?? defaultKookConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('kook', disabled)
        await reloadChannels()
        set({
          kook: disabled,
          kookGatewayStatus: {
            status: 'disconnected',
            connectedGuilds: [],
          },
          kookIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          kookIsLoading: false,
        })
        throw error
      }
    },

    refreshKookStatus: async () => {
      try {
        const list = await listChannels()
        set({ kookGatewayStatus: statusFor(list) })
      } catch (error) {
        console.error('[KOOK] Failed to refresh status:', error)
      }
    },

    testKookToken: async (_token: string) => {
      set({
        kookIsTesting: false,
        kookTestResult: {
          success: false,
          message: 'Token test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearKookTestResult: () => {
      set({ kookTestResult: null })
    },

    setKookHasChanges: (hasChanges: boolean) => {
      set({ kookHasChanges: hasChanges })
    },

    toggleKookEnabled: async (enabled: boolean, config: KookConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('kook', updatedConfig)
        await reloadChannels()
        set({ kook: updatedConfig, kookHasChanges: false })
        if (enabled) {
          set({ kookIsLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ kookGatewayStatus: statusFor(list), kookIsLoading: false })
          } catch (error) {
            console.error('[KOOK] Status check after toggle failed:', error)
            set({ kookIsLoading: false, error: describe(error) })
          }
        } else {
          set({ kookGatewayStatus: { status: 'disconnected', connectedGuilds: [] } })
        }
      } catch (error) {
        console.error('[KOOK] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
