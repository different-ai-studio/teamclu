import { describe, expect, it } from 'vitest'
import { pinChannelRuntime } from './channel-runtime'

describe('pinChannelRuntime', () => {
  const inherited = { workspaceId: 'ws-default', model: 'pi/default' }

  it('keeps an explicit choice', () => {
    expect(
      pinChannelRuntime(
        { enabled: true, workspaceId: 'ws-bot', model: 'anthropic/claude' },
        inherited,
      ),
    ).toEqual({ enabled: true, workspaceId: 'ws-bot', model: 'anthropic/claude' })
  })

  it('fills an empty field from the current default', () => {
    expect(pinChannelRuntime({ workspaceId: '  ', model: undefined }, inherited)).toEqual({
      workspaceId: 'ws-default',
      model: 'pi/default',
    })
  })

  it('leaves a field empty when nothing is configured', () => {
    expect(pinChannelRuntime({}, { workspaceId: null, model: '  ' })).toEqual({
      workspaceId: undefined,
      model: undefined,
    })
  })
})
