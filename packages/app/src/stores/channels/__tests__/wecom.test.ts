import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('@/lib/daemon/amuxd-channels', () => {
  class AmuxdUnreachableError extends Error {
    constructor() {
      super('amuxd unreachable')
      this.name = 'AmuxdUnreachableError'
    }
  }
  return {
    listChannels: vi.fn(),
    loadChannelConfig: vi.fn(),
    saveChannelConfig: vi.fn(),
    reloadChannels: vi.fn(),
    AmuxdUnreachableError,
  }
})

import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/daemon/amuxd-channels'

describe('createWecomActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadChannelConfig).mockResolvedValue(null)
  })

  it('maps amuxd channel status into the WeCom gateway slot on load', async () => {
    vi.mocked(listChannels).mockResolvedValueOnce([
      { platform: 'wecom', enabled: true, connected: true, lastError: null },
    ])

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    expect(listChannels).toHaveBeenCalledTimes(1)
    // first set: wecomIsLoading=true, second set: full payload
    const final = set.mock.calls[set.mock.calls.length - 1][0]
    expect(final.wecomGatewayStatus).toEqual({ status: 'connected' })
    expect(final.wecomIsLoading).toBe(false)
  })

  it('rehydrates saved WeCom config on load', async () => {
    vi.mocked(listChannels).mockResolvedValueOnce([
      { platform: 'wecom', enabled: false, connected: false, lastError: null },
    ])
    vi.mocked(loadChannelConfig).mockResolvedValueOnce({
      enabled: true,
      botId: 'saved-bot',
      secret: 'saved-secret',
      encodingAesKey: 'saved-key',
    })

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    const final = set.mock.calls[set.mock.calls.length - 1][0]
    expect(final.wecom).toMatchObject({
      enabled: true,
      botId: 'saved-bot',
      secret: 'saved-secret',
      encodingAesKey: 'saved-key',
    })
  })

  it('saveWecomConfig flips through wrapper + reload', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.saveWecomConfig({
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })

    expect(saveChannelConfig).toHaveBeenCalledWith('wecom', {
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })
    expect(reloadChannels).toHaveBeenCalled()
  })

  it('surfaces a friendly error when amuxd is unreachable on load', async () => {
    vi.mocked(listChannels).mockRejectedValueOnce(new AmuxdUnreachableError())

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    const errorPayload = set.mock.calls.find(
      (c) => (c[0] as { error?: string }).error
    )?.[0] as { error?: string } | undefined
    expect(errorPayload?.error).toMatch(/amuxd not running/i)
  })

  it('refreshWecomStatus reloads every bot, not only the channel flag', async () => {
    vi.mocked(listChannels).mockResolvedValueOnce([
      { platform: 'wecom', enabled: true, connected: true, lastError: null },
    ])
    invoke.mockResolvedValueOnce([
      { botId: 'b1', connected: true },
      { botId: 'b2', connected: true },
    ])

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.refreshWecomStatus()

    expect(invoke).toHaveBeenCalledWith('list_wecom_bots_status')
    expect(set).toHaveBeenCalledWith({
      wecomBotStatuses: [
        { botId: 'b1', connected: true },
        { botId: 'b2', connected: true },
      ],
    })
  })

  it('commitScannedWecomBot appends the bot without rewriting other bots or enabling the channel', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)
    const stored = {
      enabled: false,
      bots: [
        { enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep-me', botName: 'One' },
      ],
    }
    let state = { wecom: stored, wecomHasChanges: false, error: null as string | null, wecomIsLoading: false }
    const set = vi.fn((update: unknown) => {
      const patch = typeof update === 'function' ? (update as (s: typeof state) => Partial<typeof state>)(state) : update as Partial<typeof state>
      state = { ...state, ...patch }
    })

    const { createWecomActions } = await import('../wecom')
    const actions = createWecomActions(set as never)
    const result = await actions.commitScannedWecomBot(' b2 ', ' new-secret ')

    expect(result).toEqual({ appliedToStore: true })
    expect(saveChannelConfig).toHaveBeenCalledWith('wecom', {
      enabled: false,
      bots: [
        { enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep-me', botName: 'One' },
        { enabled: true, botId: 'b2', secret: 'new-secret' },
      ],
    })
    expect(reloadChannels).toHaveBeenCalledTimes(1)
    expect(state.wecom?.bots.map((bot) => bot.botId)).toEqual(['b1', 'b2'])
    expect(state.wecomHasChanges).toBe(false)
  })

  it('commitScannedWecomBot leaves a dirty form in place and still writes only the stored document', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)
    const stored = {
      enabled: true,
      bots: [{ enabled: true, botId: 'b1', secret: '', systemPrompt: 'stored' }],
    }
    let state = { wecom: stored, wecomHasChanges: true, error: null as string | null, wecomIsLoading: false }
    const set = vi.fn((update: unknown) => {
      const patch = typeof update === 'function' ? (update as (s: typeof state) => Partial<typeof state>)(state) : update as Partial<typeof state>
      state = { ...state, ...patch }
    })

    const { createWecomActions } = await import('../wecom')
    const actions = createWecomActions(set as never)
    const result = await actions.commitScannedWecomBot('b1', 'rotated')

    expect(result).toEqual({ appliedToStore: false })
    expect(saveChannelConfig).toHaveBeenCalledWith('wecom', {
      enabled: true,
      bots: [{ enabled: true, botId: 'b1', secret: 'rotated', systemPrompt: 'stored' }],
    })
    expect(state.wecom).toBe(stored)
    expect(state.wecomHasChanges).toBe(true)
  })

  it('commitScannedWecomBot leaves the saved bots untouched when the write fails', async () => {
    vi.mocked(saveChannelConfig).mockRejectedValueOnce(new Error('disk full'))
    const stored = {
      enabled: true,
      bots: [{ enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep' }],
    }
    let state = { wecom: stored, wecomHasChanges: false, error: null as string | null, wecomIsLoading: false }
    const set = vi.fn((update: unknown) => {
      const patch = typeof update === 'function' ? (update as (s: typeof state) => Partial<typeof state>)(state) : update as Partial<typeof state>
      state = { ...state, ...patch }
    })

    const { createWecomActions } = await import('../wecom')
    const actions = createWecomActions(set as never)
    await expect(actions.commitScannedWecomBot('b2', 'new-secret')).rejects.toThrow(/disk full/)

    expect(reloadChannels).not.toHaveBeenCalled()
    expect(state.wecom).toBe(stored)
    expect(state.wecom.bots.map((bot) => bot.botId)).toEqual(['b1'])
    expect(state.wecom.bots[0].enabled).toBe(false)
    expect(state.wecom.bots[0].systemPrompt).toBe('keep')
  })

  it('commitScannedWecomBot does not save an empty secret', async () => {
    const { createWecomActions } = await import('../wecom')
    const actions = createWecomActions(vi.fn() as never)
    await expect(actions.commitScannedWecomBot('b1', '  ')).rejects.toThrow(/required/)
    expect(saveChannelConfig).not.toHaveBeenCalled()
  })

  it('mergeScannedWecomBot keeps every other field on the existing bots', async () => {
    const { mergeScannedWecomBot } = await import('../wecom')
    expect(mergeScannedWecomBot(
      [{ enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep' }],
      'b2',
      'sec',
    )).toEqual([
      { enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep' },
      { enabled: true, botId: 'b2', secret: 'sec' },
    ])
  })

  it('mergeScannedWecomBot refreshes a repeated bot id without adding a second row', async () => {
    const { mergeScannedWecomBot } = await import('../wecom')
    expect(mergeScannedWecomBot(
      [
        { enabled: false, botId: 'b1', secret: '', systemPrompt: 'keep', botName: 'One' },
        { enabled: true, botId: 'b2', secret: '', encodingAesKey: 'aes' },
      ],
      'b1',
      'rotated',
    )).toEqual([
      { enabled: false, botId: 'b1', secret: 'rotated', systemPrompt: 'keep', botName: 'One' },
      { enabled: true, botId: 'b2', secret: '', encodingAesKey: 'aes' },
    ])
  })

  it('toggleWecomEnabled saves disabled config and clears status', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.toggleWecomEnabled(false, {
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })

    expect(saveChannelConfig).toHaveBeenCalledWith(
      'wecom',
      expect.objectContaining({ enabled: false })
    )
  })
})
