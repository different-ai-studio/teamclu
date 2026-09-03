import { describe, expect, it } from 'vitest'

import { AgentType } from '@/lib/proto/amux_pb'

import { amuxAgentTypeFromBackend, resolveAmuxAgentType } from '@/lib/agent/amux-agent-type'

describe('resolveAmuxAgentType', () => {
  it('prefers explicit backend type when present', () => {
    expect(resolveAmuxAgentType('opencode')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType('pi')).toBe(AgentType.PI)
    expect(resolveAmuxAgentType('claude-code')).toBe(AgentType.CLAUDE_CODE)
    expect(resolveAmuxAgentType('claude')).toBe(AgentType.CLAUDE_CODE)
    expect(resolveAmuxAgentType('claude_code')).toBe(AgentType.CLAUDE_CODE)
  })

  it('maps cursor to CURSOR instead of silently running as opencode', () => {
    // Mirrors the daemon-side fix in #649 (`"cursor" => AgentType::Opencode`
    // → `AgentType::Cursor`); the client half used to fall through to the
    // opencode default here.
    expect(resolveAmuxAgentType('cursor')).toBe(AgentType.CURSOR)
    expect(resolveAmuxAgentType(undefined, 'cursor')).toBe(AgentType.CURSOR)
  })

  it('falls back to agent kind when backend history is missing', () => {
    expect(resolveAmuxAgentType(null, 'daemon')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'amuxd')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'opencode')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'pi')).toBe(AgentType.PI)
  })

  it('defaults unknown combinations to opencode (single-agent mode)', () => {
    expect(resolveAmuxAgentType(undefined, undefined)).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType('something-else', 'member')).toBe(AgentType.OPENCODE)
  })

  it('treats codex as unsupported — there is no codex backend to run', () => {
    // `create_backend` has no codex arm, so a codex-configured daemon actually
    // runs opencode. Resolving to the opencode default is the honest answer.
    expect(resolveAmuxAgentType('codex')).toBe(AgentType.OPENCODE)
    expect(amuxAgentTypeFromBackend('codex')).toBeNull()
  })
})

describe('amuxAgentTypeFromBackend', () => {
  it('covers every backend amuxd implements', () => {
    expect(amuxAgentTypeFromBackend('opencode')).toBe('opencode')
    expect(amuxAgentTypeFromBackend('pi')).toBe('pi')
    expect(amuxAgentTypeFromBackend('cursor')).toBe('cursor')
    expect(amuxAgentTypeFromBackend('claude-code')).toBe('claude-code')
    expect(amuxAgentTypeFromBackend('claude')).toBe('claude-code')
    expect(amuxAgentTypeFromBackend('claude_code')).toBe('claude-code')
  })

  it('returns null for unknown backends', () => {
    expect(amuxAgentTypeFromBackend(null)).toBeNull()
    expect(amuxAgentTypeFromBackend('nope')).toBeNull()
  })
})
