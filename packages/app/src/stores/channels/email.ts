import type {
  EmailConfig,
  EmailGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultEmailConfig } from '../channels-types'
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(list: Awaited<ReturnType<typeof listChannels>>): EmailGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'email')
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

export function createEmailActions(set: ChannelsSet) {
  return {
    loadEmailConfig: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        const [list, storedConfig] = await Promise.all([
          listChannels(),
          loadChannelConfig<EmailConfig>('email'),
        ])
        set({
          email: { ...defaultEmailConfig, ...storedConfig },
          emailGatewayStatus: statusFor(list),
          emailIsLoading: false,
          emailHasChanges: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          emailIsLoading: false,
        })
      }
    },

    saveEmailConfig: async (config: EmailConfig) => {
      set({ emailIsLoading: true, error: null })
      try {
        await saveChannelConfig('email', config)
        await reloadChannels()
        set({
          email: config,
          emailIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          emailIsLoading: false,
        })
        throw error
      }
    },

    startEmailGateway: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        let cfg: EmailConfig = defaultEmailConfig
        set((state) => {
          cfg = state.email ?? defaultEmailConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('email', enabled)
        await reloadChannels()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const list = await listChannels()
        set({
          email: enabled,
          emailGatewayStatus: statusFor(list),
          emailIsLoading: false,
          emailHasChanges: false,
        })
      } catch (error) {
        const errorMessage = describe(error)
        set({
          error: errorMessage,
          emailIsLoading: false,
          emailGatewayStatus: {
            status: 'error',
            errorMessage,
          },
        })
        throw error
      }
    },

    stopEmailGateway: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        let cfg: EmailConfig = defaultEmailConfig
        set((state) => {
          cfg = state.email ?? defaultEmailConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('email', disabled)
        await reloadChannels()
        set({
          email: disabled,
          emailGatewayStatus: { status: 'disconnected' },
          emailIsLoading: false,
        })
      } catch (error) {
        set({
          error: describe(error),
          emailIsLoading: false,
        })
        throw error
      }
    },

    refreshEmailStatus: async () => {
      try {
        const list = await listChannels()
        set({ emailGatewayStatus: statusFor(list) })
      } catch (error) {
        console.error('Failed to refresh Email gateway status:', error)
      }
    },

    testEmailConnection: async (_config: EmailConfig) => {
      set({
        emailIsTesting: false,
        emailTestResult: {
          success: false,
          message: 'Connection test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    gmailAuthorize: async (_clientId: string, _clientSecret: string, _email: string) => {
      set({
        emailIsLoading: false,
        gmailAuthUrl: null,
        emailTestResult: {
          success: false,
          message: 'Gmail authorization is no longer driven by the desktop app. Run the OAuth flow via amuxd (see daemon docs).',
        },
      })
      return false
    },

    checkGmailAuth: async () => {
      return false
    },

    clearEmailTestResult: () => set({ emailTestResult: null }),
    setEmailHasChanges: (hasChanges: boolean) => set({ emailHasChanges: hasChanges }),

    toggleEmailEnabled: async (enabled: boolean, config: EmailConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('email', updatedConfig)
        await reloadChannels()
        set({ email: updatedConfig, emailHasChanges: false })
        if (enabled) {
          set({ emailIsLoading: true })
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ emailGatewayStatus: statusFor(list), emailIsLoading: false })
          } catch (error) {
            console.error('[Email] Status check after toggle failed:', error)
            set({ emailIsLoading: false, error: describe(error) })
          }
        } else {
          set({ emailGatewayStatus: { status: 'disconnected' } })
        }
      } catch (error) {
        console.error('[Email] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
