import type { WeChatPadConfig, WeChatPadGatewayStatusResponse, ChannelsState } from '../channels-types'
import { defaultWeChatPadConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function wechatpadStatus(
  list: Awaited<ReturnType<typeof listChannels>>,
): WeChatPadGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'wechatpad')
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

export function createWechatpadActions(set: ChannelsSet) {
  const current = (): WeChatPadConfig => {
    let cfg: WeChatPadConfig = defaultWeChatPadConfig
    set((state) => {
      cfg = state.wechatpad ?? defaultWeChatPadConfig
      return {}
    })
    return cfg
  }

  const persist = async (config: WeChatPadConfig) => {
    await saveChannelConfig('wechatpad', config)
    await reloadChannels()
  }

  return {
    loadWechatpadConfig: async () => {
      set({ wechatpadIsLoading: true })
      try {
        const [list, stored] = await Promise.all([
          listChannels(),
          loadChannelConfig<WeChatPadConfig>('wechatpad'),
        ])
        set({
          wechatpad: { ...defaultWeChatPadConfig, ...stored },
          wechatpadGatewayStatus: wechatpadStatus(list),
          wechatpadIsLoading: false,
          error: null,
        })
      } catch (e) {
        console.error('[WeChatPad] Failed to load config:', e)
        set({ wechatpadIsLoading: false, error: describe(e) })
      }
    },

    saveWechatpadConfig: async (config: WeChatPadConfig) => {
      set({ wechatpadIsLoading: true, error: null })
      try {
        await persist(config)
        set({ wechatpad: config, wechatpadHasChanges: false, wechatpadIsLoading: false, error: null })
      } catch (e) {
        console.error('[WeChatPad] Failed to save config:', e)
        set({ error: describe(e), wechatpadIsLoading: false })
        // `error` is never rendered; a silent catch would make a failed save
        // look like a successful one.
        throw new Error(describe(e), { cause: e })
      }
    },

    startWechatpadGateway: async () => {
      try {
        const enabled = { ...current(), enabled: true }
        await persist(enabled)
        const list = await listChannels()
        set({ wechatpad: enabled, wechatpadGatewayStatus: wechatpadStatus(list), error: null })
      } catch (e) {
        console.error('[WeChatPad] Failed to start gateway:', e)
        set({ wechatpadGatewayStatus: { status: 'error', errorMessage: describe(e) }, error: describe(e) })
      }
    },

    stopWechatpadGateway: async () => {
      try {
        const disabled = { ...current(), enabled: false }
        await persist(disabled)
        set({ wechatpad: disabled, wechatpadGatewayStatus: { status: 'disconnected' }, error: null })
      } catch (e) {
        console.error('[WeChatPad] Failed to stop gateway:', e)
        set({ error: describe(e) })
      }
    },

    refreshWechatpadStatus: async () => {
      try {
        const list = await listChannels()
        set({ wechatpadGatewayStatus: wechatpadStatus(list), error: null })
      } catch (e) {
        console.error('[WeChatPad] Failed to refresh status:', e)
      }
    },

    setWechatpadHasChanges: (hasChanges: boolean) => set({ wechatpadHasChanges: hasChanges }),

    toggleWechatpadEnabled: async (enabled: boolean, config: WeChatPadConfig) => {
      const updated = { ...config, enabled }
      try {
        await persist(updated)
        set({ wechatpad: updated, wechatpadHasChanges: false, error: null })
        if (!enabled) {
          set({ wechatpadGatewayStatus: { status: 'disconnected' } })
          return
        }
        // Attaching to the protocol server takes a round trip or two.
        set({ wechatpadIsLoading: true })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({ wechatpadGatewayStatus: wechatpadStatus(list), wechatpadIsLoading: false, error: null })
      } catch (e) {
        console.error('[WeChatPad] Toggle enabled failed:', e)
        set({ wechatpadIsLoading: false, error: describe(e) })
      }
    },
  }
}
