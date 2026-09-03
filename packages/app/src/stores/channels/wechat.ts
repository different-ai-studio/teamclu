import type {
  WeChatConfig,
  WeChatGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultWeChatConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): WeChatGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'wechat')
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

export function createWechatActions(set: ChannelsSet) {
  return {
    loadWechatConfig: async () => {
      set({ wechatIsLoading: true })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<WeChatConfig>('wechat'),
        ])
        set({
          wechat: { ...defaultWeChatConfig, ...storedConfig },
          wechatGatewayStatus: statusFor(list),
          wechatIsLoading: false,
          error: null,
        })
      } catch (e) {
        console.error('[WeChat] Failed to load config:', e)
        set({ wechatIsLoading: false, error: describe(e) })
      }
    },

    saveWechatConfig: async (config: WeChatConfig) => {
      set({ wechatIsLoading: true, error: null })
      try {
        await saveChannelConfig('wechat', config)
        await reloadChannels()
        set({ wechat: config, wechatHasChanges: false, wechatIsLoading: false, error: null })
      } catch (e) {
        console.error('[WeChat] Failed to save config:', e)
        set({ error: describe(e), wechatIsLoading: false })
        // Rethrow for the same reason as WeCom: `error` is never rendered, so a
        // silent catch here made a failed save look like a successful one.
        throw new Error(describe(e), { cause: e })
      }
    },

    startWechatGateway: async () => {
      try {
        let cfg: WeChatConfig = defaultWeChatConfig
        set((state) => {
          cfg = state.wechat ?? defaultWeChatConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('wechat', enabled)
        await reloadChannels()
        const list = await listChannels()
        set({ wechat: enabled, wechatGatewayStatus: statusFor(list), error: null })
      } catch (e) {
        console.error('[WeChat] Failed to start gateway:', e)
        set({ wechatGatewayStatus: { status: 'error', errorMessage: describe(e) }, error: describe(e) })
      }
    },

    stopWechatGateway: async () => {
      try {
        let cfg: WeChatConfig = defaultWeChatConfig
        set((state) => {
          cfg = state.wechat ?? defaultWeChatConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('wechat', disabled)
        await reloadChannels()
        set({ wechat: disabled, wechatGatewayStatus: { status: 'disconnected' }, error: null })
      } catch (e) {
        console.error('[WeChat] Failed to stop gateway:', e)
        set({ error: describe(e) })
      }
    },

    refreshWechatStatus: async () => {
      try {
        const list = await listChannels()
        set({ wechatGatewayStatus: statusFor(list), error: null })
      } catch (e) {
        console.error('[WeChat] Failed to refresh status:', e)
      }
    },

    testWechatConnection: async (_botToken: string) => {
      set({
        wechatIsTesting: false,
        wechatTestResult: {
          success: false,
          message: 'Connection test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearWechatTestResult: () => set({ wechatTestResult: null }),

    setWechatHasChanges: (hasChanges: boolean) => set({ wechatHasChanges: hasChanges }),

    toggleWechatEnabled: async (enabled: boolean, config: WeChatConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('wechat', updatedConfig)
        await reloadChannels()
        set({ wechat: updatedConfig, wechatHasChanges: false, error: null })
        if (enabled) {
          set({ wechatIsLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ wechatGatewayStatus: statusFor(list), wechatIsLoading: false, error: null })
          } catch (error) {
            console.error('[WeChat] Status check after toggle failed:', error)
            set({ wechatIsLoading: false, error: describe(error) })
          }
        } else {
          set({ wechatGatewayStatus: { status: 'disconnected' }, error: null })
        }
      } catch (error) {
        console.error('[WeChat] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
