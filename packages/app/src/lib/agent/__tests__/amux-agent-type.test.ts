import { describe, expect, it } from 'vitest'

import { AgentType } from '@/lib/proto/amux_pb'

import { amuxAgentTypeFromBackend, resolveAmuxAgentType } from '@/lib/agent/amux-agent-type'

describe('resolveAmuxAgentType', () => {
  it('always resolves to pi regardless of legacy backend labels', () => {
    expect(resolveAmuxAgentType('opencode')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType('pi')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType('claude-code')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType('cursor')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType(undefined, 'daemon')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType(undefined, undefined)).toBe(AgentType.PI)
  })
})

describe('amuxAgentTypeFromBackend', () => {
  it('maps any known backend label to pi', () => {
    expect(amuxAgentTypeFromBackend('opencode')).toBe('pi')
    expect(amuxAgentTypeFromBackend('pi')).toBe('pi')
    expect(amuxAgentTypeFromBackend('cursor')).toBe('pi')
    expect(amuxAgentTypeFromBackend('claude-code')).toBe('pi')
  })

  it('returns null for empty input', () => {
    expect(amuxAgentTypeFromBackend(null)).toBeNull()
    expect(amuxAgentTypeFromBackend('')).toBeNull()
  })
})
