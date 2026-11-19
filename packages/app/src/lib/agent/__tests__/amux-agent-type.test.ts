import { describe, expect, it } from 'vitest'

import { AgentType } from '@/lib/proto/amux_pb'

import { resolveAmuxAgentType } from '@/lib/agent/amux-agent-type'

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
