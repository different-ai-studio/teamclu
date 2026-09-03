import type {
  FeishuConfig,
  FeishuGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultFeishuConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): FeishuGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'feishu')
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

export function createFeishuActions(set: ChannelsSet) {
  return {
    loadFeishuConfig: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<FeishuConfig>('feishu'),
        ])
        set({
          feishu: { ...defaultFeishuConfig, ...storedConfig },
          feishuGatewayStatus: statusFor(list),
          feishuIsLoading: false,
          feishuHasChanges: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          feishuIsLoading: false,
        })
      }
    },

    saveFeishuConfig: async (config: FeishuConfig) => {
      set({ feishuIsLoading: true, error: null })
      try {
        await saveChannelConfig('feishu', config)
        await reloadChannels()
        set({
          feishu: config,
          feishuIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          feishuIsLoading: false,
        })
        throw error
      }
    },

    startFeishuGateway: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        let cfg: FeishuConfig = defaultFeishuConfig
        set((state) => {
          cfg = state.feishu ?? defaultFeishuConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('feishu', enabled)
        await reloadChannels()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({
          feishu: enabled,
          feishuGatewayStatus: statusFor(list),
          feishuIsLoading: false,
          feishuHasChanges: false,
        })
      } catch (error) {
        const errorMessage = describe(error)
        set({
          error: errorMessage,
          feishuIsLoading: false,
          feishuGatewayStatus: {
            status: 'error',
            errorMessage,
          },
        })
        throw error
      }
    },

    stopFeishuGateway: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        let cfg: FeishuConfig = defaultFeishuConfig
        set((state) => {
          cfg = state.feishu ?? defaultFeishuConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('feishu', disabled)
        await reloadChannels()
        set({
          feishu: disabled,
          feishuGatewayStatus: { status: 'disconnected' },
          feishuIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          feishuIsLoading: false,
        })
        throw error
      }
    },

    refreshFeishuStatus: async () => {
      try {
        const list = await listChannels()
        set({ feishuGatewayStatus: statusFor(list) })
      } catch (error) {
        console.error('Failed to refresh Feishu gateway status:', error)
      }
    },

    testFeishuCredentials: async (_appId: string, _appSecret: string) => {
      set({
        feishuIsTesting: false,
        feishuTestResult: {
          success: false,
          message: 'Credential test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearFeishuTestResult: () => set({ feishuTestResult: null }),
    setFeishuHasChanges: (hasChanges: boolean) => set({ feishuHasChanges: hasChanges }),

    toggleFeishuEnabled: async (enabled: boolean, config: FeishuConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('feishu', updatedConfig)
        await reloadChannels()
        set({ feishu: updatedConfig, feishuHasChanges: false })
        if (enabled) {
          set({ feishuIsLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ feishuGatewayStatus: statusFor(list), feishuIsLoading: false })
          } catch (error) {
            console.error('[Feishu] Status check after toggle failed:', error)
            set({ feishuIsLoading: false, error: describe(error) })
          }
        } else {
          set({ feishuGatewayStatus: { status: 'disconnected' } })
        }
      } catch (error) {
        console.error('[Feishu] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
