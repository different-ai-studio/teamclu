import { describe, expect, it } from 'vitest'
import { pinChannelRuntime, sessionDefaultModel } from './channel-runtime'

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

describe('sessionDefaultModel', () => {
  const models = [{ id: 'anthropic/claude-sonnet' }, { id: 'team/glm-4.6' }]

  it('uses the model a new chat would start on when the catalog still offers it', () => {
    expect(sessionDefaultModel(models, ['missing/old', 'team/glm-4.6'])).toBe('team/glm-4.6')
  })

  it('uses the first advertised model when this client has no matching pick', () => {
    expect(sessionDefaultModel(models, ['retired/model'])).toBe('anthropic/claude-sonnet')
  })

  it('returns null when there is no model to pin', () => {
    expect(sessionDefaultModel([], ['team/glm-4.6'])).toBeNull()
  })
})
