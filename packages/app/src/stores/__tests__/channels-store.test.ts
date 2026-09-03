import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/daemon/amuxd-channels', () => {
  class AmuxdUnreachableError extends Error {
    constructor() {
      super('amuxd unreachable')
      this.name = 'AmuxdUnreachableError'
    }
  }
  return {
    listChannels: vi.fn().mockResolvedValue([]),
    loadChannelConfig: vi.fn().mockResolvedValue(null),
    saveChannelConfig: vi.fn().mockResolvedValue(undefined),
    reloadChannels: vi.fn().mockResolvedValue(undefined),
    AmuxdUnreachableError,
  }
})

vi.mock('@/stores/channels/discord', () => ({
  createDiscordActions: () => ({}),
}))

vi.mock('@/stores/channels/feishu', () => ({
  createFeishuActions: () => ({}),
}))

vi.mock('@/stores/channels/email', () => ({
  createEmailActions: () => ({}),
}))

vi.mock('@/stores/channels/kook', () => ({
  createKookActions: () => ({}),
}))

vi.mock('@/stores/channels/wecom', () => ({
  createWecomActions: () => ({}),
}))

vi.mock('@/stores/channels/wechat', () => ({
  createWechatActions: () => ({}),
}))

vi.mock('@/stores/channels-types', () => ({
  defaultDiscordConfig: { enabled: false, token: '', guildId: '' },
  defaultFeishuConfig: { enabled: false },
  defaultKookConfig: { enabled: false },
  defaultEmailConfig: { enabled: false },
  defaultWeComConfig: { enabled: false },
  defaultWeChatConfig: { enabled: false },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChannelsStore', () => {
  it('has correct initial state', async () => {
    const { useChannelsStore } = await import('@/stores/channels-store')
    const state = useChannelsStore.getState()
    expect(state.gatewayStatus.status).toBe('disconnected')
    expect(state.feishuGatewayStatus.status).toBe('disconnected')
    expect(state.isLoading).toBe(false)
    expect(state.hasChanges).toBe(false)
  })

  it('stopAllAndReset resets all state', async () => {
    const { useChannelsStore } = await import('@/stores/channels-store')
    await useChannelsStore.getState().stopAllAndReset()
    const state = useChannelsStore.getState()
    expect(state.discord).toBeNull()
    expect(state.feishu).toBeNull()
    expect(state.email).toBeNull()
    expect(state.kook).toBeNull()
    expect(state.wecom).toBeNull()
    expect(state.gatewayStatus.status).toBe('disconnected')
  })

  it('keepAliveCheck calls amuxd listChannels', async () => {
    const { listChannels } = await import('@/lib/daemon/amuxd-channels')
    const { useChannelsStore } = await import('@/stores/channels-store')
    await useChannelsStore.getState().keepAliveCheck()
    expect(listChannels).toHaveBeenCalled()
  })

  it('loadConfig surfaces amuxd-unreachable as a UI error', async () => {
    const { listChannels, AmuxdUnreachableError } = await import('@/lib/daemon/amuxd-channels')
    vi.mocked(listChannels).mockRejectedValueOnce(new AmuxdUnreachableError())
    const { useChannelsStore } = await import('@/stores/channels-store')
    await useChannelsStore.getState().loadConfig()
    expect(useChannelsStore.getState().error).toMatch(/amuxd not running/i)
  })
})
