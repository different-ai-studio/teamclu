import type {
  WeComConfig,
  WeComBot,
  WeComGatewayStatusResponse,
  WeComBotStatus,
  WeComQrAuthStart,
  WeComQrAuthPollResult,
  ChannelsState,
} from '../channels-types'
import { defaultWeComConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'
import { invoke } from '@tauri-apps/api/core'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(platform: 'wecom', list: Awaited<ReturnType<typeof listChannels>>): WeComGatewayStatusResponse {
  const entry = list.find((c) => c.platform === platform)
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

/**
 * Insert or refresh one scanned bot without touching the other bots' fields.
 * An empty id or secret is refused so a partial poll cannot be stored.
 */
export function mergeScannedWecomBot(bots: WeComBot[], botId: string, secret: string): WeComBot[] {
  const id = botId.trim()
  const sec = secret.trim()
  if (!id || !sec) return bots
  const index = bots.findIndex((bot) => bot.botId.trim() === id)
  if (index === -1) {
    return [...bots, { enabled: true, botId: id, secret: sec }]
  }
  return bots.map((bot, i) => (i === index ? { ...bot, botId: id, secret: sec } : bot))
}

export function createWecomActions(set: ChannelsSet) {
  return {
    loadWecomConfig: async () => {
      set({ wecomIsLoading: true })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<WeComConfig>('wecom'),
        ])
        set({
          wecom: { ...defaultWeComConfig, ...storedConfig },
          wecomGatewayStatus: statusFor('wecom', list),
          wecomIsLoading: false,
          error: null,
        })
      } catch (e) {
        console.error('[WeCom] Failed to load config:', e)
        set({ wecomIsLoading: false, error: describe(e) })
      }
    },

    saveWecomConfig: async (config: WeComConfig) => {
      set({ wecomIsLoading: true, error: null })
      try {
        await saveChannelConfig('wecom', config)
        await reloadChannels()
        set({ wecom: config, wecomHasChanges: false, wecomIsLoading: false, error: null })
      } catch (e) {
        console.error('[WeCom] Failed to save config:', e)
        set({ error: describe(e), wecomIsLoading: false })
        // Rethrow so the caller can say so. `error` is not rendered anywhere in
        // the channel settings, so swallowing it here left a failed save
        // indistinguishable from a successful one — the button just sat there.
        throw new Error(describe(e), { cause: e })
      }
    },

    startWecomGateway: async () => {
      const current = (await (async () => null as WeComConfig | null)()) // placeholder for type
      void current
      try {
        // Read latest config from store via a no-op set callback
        let cfg: WeComConfig = defaultWeComConfig
        set((state) => {
          cfg = state.wecom ?? defaultWeComConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('wecom', enabled)
        await reloadChannels()
        const list = await listChannels()
        set({ wecom: enabled, wecomGatewayStatus: statusFor('wecom', list), error: null })
      } catch (e) {
        console.error('[WeCom] Failed to start gateway:', e)
        set({ wecomGatewayStatus: { status: 'error', errorMessage: describe(e) }, error: describe(e) })
      }
    },

    stopWecomGateway: async () => {
      try {
        let cfg: WeComConfig = defaultWeComConfig
        set((state) => {
          cfg = state.wecom ?? defaultWeComConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('wecom', disabled)
        await reloadChannels()
        set({ wecom: disabled, wecomGatewayStatus: { status: 'disconnected' }, error: null })
      } catch (e) {
        console.error('[WeCom] Failed to stop gateway:', e)
        set({ error: describe(e) })
      }
    },

    refreshWecomStatus: async () => {
      // The channel flag is true when any bot is up. Per-bot rows used to be
      // read once on open, so a bot that finished connecting after that read
      // stayed on "disconnected" for as long as the page was open.
      try {
        const list = await listChannels()
        set({ wecomGatewayStatus: statusFor('wecom', list), error: null })
      } catch (e) {
        console.error('[WeCom] Failed to refresh status:', e)
      }
      try {
        const statuses = await invoke<WeComBotStatus[]>('list_wecom_bots_status')
        if (Array.isArray(statuses)) set({ wecomBotStatuses: statuses })
      } catch (e) {
        console.error('[WeCom] Failed to refresh per-bot statuses:', e)
      }
    },

    loadWecomBotStatuses: async () => {
      try {
        const statuses = await invoke<WeComBotStatus[]>('list_wecom_bots_status')
        set({ wecomBotStatuses: Array.isArray(statuses) ? statuses : [] })
      } catch (e) {
        console.error('[WeCom] Failed to load per-bot statuses:', e)
        set({ wecomBotStatuses: [] })
      }
    },

    testWecomCredentials: async (_botId: string, _secret: string) => {
      // Credential probing is no longer a Tauri command — amuxd validates the
      // bot on startup. Save the config and watch the gateway status instead.
      set({
        wecomIsTesting: false,
        wecomTestResult: {
          success: false,
          message: 'Credential test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearWecomTestResult: () => set({ wecomTestResult: null }),

    /**
     * Persist one scanned bot onto the last saved WeCom config.
     *
     * The payload is the stored document plus that bot, not the form's dirty
     * copy, so an unsaved edit to another bot or another field is not written.
     * Empty secrets on the other bots stay empty, which the daemon treats as
     * "keep the stored secret". When the form is clean, the store adopts the
     * saved document. When it is dirty, the store is left alone and the caller
     * merges the bot into local state itself.
     */
    commitScannedWecomBot: async (
      botId: string,
      secret: string,
    ): Promise<{ appliedToStore: boolean }> => {
      const id = botId.trim()
      const sec = secret.trim()
      if (!id || !sec) throw new Error('WeCom bot id and secret are required')

      let stored: WeComConfig = defaultWeComConfig
      set((state) => {
        stored = state.wecom ?? defaultWeComConfig
        return {}
      })
      const next: WeComConfig = {
        ...stored,
        bots: mergeScannedWecomBot(stored.bots ?? [], id, sec),
      }
      try {
        await saveChannelConfig('wecom', next)
        await reloadChannels()
      } catch (e) {
        const message = describe(e)
        set({ error: message, wecomIsLoading: false })
        throw new Error(message, { cause: e })
      }

      let dirty = false
      set((state) => {
        dirty = state.wecomHasChanges
        return {}
      })
      if (!dirty) {
        set({ wecom: next, wecomHasChanges: false, error: null })
        return { appliedToStore: true }
      }
      return { appliedToStore: false }
    },

    startWecomQrAuth: async (): Promise<WeComQrAuthStart> => {
      return await invoke<WeComQrAuthStart>('start_wecom_qr_auth')
    },

    pollWecomQrAuth: async (scode: string): Promise<WeComQrAuthPollResult> => {
      return await invoke<WeComQrAuthPollResult>('poll_wecom_qr_auth', { scode })
    },

    setWecomHasChanges: (hasChanges: boolean) => set({ wecomHasChanges: hasChanges }),

    toggleWecomEnabled: async (enabled: boolean, config: WeComConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('wecom', updatedConfig)
        await reloadChannels()
        set({ wecom: updatedConfig, wecomHasChanges: false, error: null })
        if (enabled) {
          set({ wecomIsLoading: true })
          // give amuxd a moment to reconcile, then fetch status
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ wecomGatewayStatus: statusFor('wecom', list), wecomIsLoading: false, error: null })
          } catch (error) {
            console.error('[WeCom] Status check after toggle failed:', error)
            set({ wecomIsLoading: false, error: describe(error) })
          }
        } else {
          set({ wecomGatewayStatus: { status: 'disconnected' }, error: null })
        }
      } catch (error) {
        console.error('[WeCom] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
