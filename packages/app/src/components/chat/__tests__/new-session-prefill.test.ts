import { describe, it, expect } from 'vitest'
import { computeInitialSelection } from '../new-session-prefill'

describe('computeInitialSelection', () => {
  it('pre-selects the effective default agent when it is a candidate', () => {
    const result = computeInitialSelection('agent-1', new Set(['agent-1', 'agent-2', 'member-1']))
    expect(result).toEqual(new Set(['agent-1']))
  })

  it('selects nothing when effective agent is not in candidates', () => {
    const result = computeInitialSelection('agent-99', new Set(['agent-1', 'member-1']))
    expect(result).toEqual(new Set())
  })

  it('selects nothing when effectiveDefaultAgentId is null', () => {
    const result = computeInitialSelection(null, new Set(['agent-1', 'member-1']))
    expect(result).toEqual(new Set())
  })

  it('also pre-selects the local daemon agent, even when the default is a different row', () => {
    const result = computeInitialSelection(
      'agent-remote',
      new Set(['agent-remote', 'agent-local', 'member-1']),
      'agent-local',
    )
    expect(result).toEqual(new Set(['agent-remote', 'agent-local']))
  })

  it('pre-selects only the local agent when there is no team default', () => {
    const result = computeInitialSelection(null, new Set(['agent-local', 'member-1']), 'agent-local')
    expect(result).toEqual(new Set(['agent-local']))
  })
})
