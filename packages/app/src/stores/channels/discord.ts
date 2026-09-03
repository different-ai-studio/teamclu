import type {
  DiscordConfig,
  GatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultDiscordConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): GatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'discord')
  if (!entry) {
    return { status: 'disconnected', discordConnected: false, connectedGuilds: [] }
  }
  if (entry.lastError) {
    return {
      status: 'error',
      discordConnected: false,
      errorMessage: entry.lastError,
      connectedGuilds: [],
    }
  }
  if (entry.connected) {
    return { status: 'connected', discordConnected: true, connectedGuilds: [] }
  }
  if (entry.enabled) {
    return { status: 'connecting', discordConnected: false, connectedGuilds: [] }
  }
  return { status: 'disconnected', discordConnected: false, connectedGuilds: [] }
}

function describe(e: unknown): string {
  if (e instanceof AmuxdUnreachableError) return 'amuxd not running. Start amuxd and try again.'
  return e instanceof Error ? e.message : String(e)
}

export function createDiscordActions(set: ChannelsSet) {
  return {
    loadConfig: async () => {
      set({ isLoading: true, error: null })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<DiscordConfig>('discord'),
        ])
        set({
          discord: { ...defaultDiscordConfig, ...storedConfig },
          gatewayStatus: statusFor(list),
          isLoading: false,
          hasChanges: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          isLoading: false,
        })
      }
    },

    saveDiscordConfig: async (config: DiscordConfig) => {
      set({ isLoading: true, error: null })
      try {
        await saveChannelConfig('discord', config)
        await reloadChannels()
        set({
          discord: config,
          isLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          isLoading: false,
        })
        throw error
      }
    },

    startGateway: async () => {
      set({ isLoading: true, error: null })
      try {
        let cfg: DiscordConfig = defaultDiscordConfig
        set((state) => {
          cfg = state.discord ?? defaultDiscordConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('discord', enabled)
        await reloadChannels()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({
          discord: enabled,
          gatewayStatus: statusFor(list),
          isLoading: false,
          hasChanges: false,
        })
      } catch (error) {
        const errorMessage = describe(error)
        set({
          error: errorMessage,
          isLoading: false,
          gatewayStatus: {
            status: 'error',
            discordConnected: false,
            errorMessage,
            connectedGuilds: [],
          },
        })
        throw error
      }
    },

    stopGateway: async () => {
      set({ isLoading: true, error: null })
      try {
        let cfg: DiscordConfig = defaultDiscordConfig
        set((state) => {
          cfg = state.discord ?? defaultDiscordConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('discord', disabled)
        await reloadChannels()
        set({
          discord: disabled,
          gatewayStatus: {
            status: 'disconnected',
            discordConnected: false,
            connectedGuilds: [],
          },
          isLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          isLoading: false,
        })
        throw error
      }
    },

    refreshStatus: async () => {
      try {
        const list = await listChannels()
        set({ gatewayStatus: statusFor(list) })
      } catch (error) {
        console.error('Failed to refresh gateway status:', error)
      }
    },

    testToken: async (_token: string) => {
      set({
        isTesting: false,
        testResult: {
          success: false,
          message: 'Token test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearError: () => set({ error: null }),
    clearTestResult: () => set({ testResult: null }),
    setHasChanges: (hasChanges: boolean) => set({ hasChanges }),

    toggleDiscordEnabled: async (enabled: boolean, config: DiscordConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('discord', updatedConfig)
        await reloadChannels()
        set({ discord: updatedConfig, hasChanges: false })
        if (enabled) {
          set({ isLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ gatewayStatus: statusFor(list), isLoading: false })
          } catch (error) {
            console.error('[Discord] Status check after toggle failed:', error)
            set({ isLoading: false, error: describe(error) })
          }
        } else {
          set({
            gatewayStatus: {
              status: 'disconnected',
              discordConnected: false,
              connectedGuilds: [],
            },
          })
        }
      } catch (error) {
        console.error('[Discord] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
