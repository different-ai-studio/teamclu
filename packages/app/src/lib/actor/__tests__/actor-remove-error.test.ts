import { describe, it, expect } from 'vitest'
import { formatActorRemoveError } from '@/lib/actor/actor-remove-error'

const t = (key: string, fallback?: string, opts?: Record<string, unknown>) => {
  const fb = typeof fallback === 'string' ? fallback : key
  if (opts) return fb.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts[name] ?? ''))
  return fb
}

describe('formatActorRemoveError', () => {
  it('maps last owner error', () => {
    expect(formatActorRemoveError('cannot remove the last owner', t)).toMatch(/last team owner/i)
  })

  it('maps self-remove error', () => {
    expect(formatActorRemoveError('cannot remove your own actor', t)).toMatch(/yourself/i)
  })

  it('maps personal-agent owner-only error', () => {
    expect(formatActorRemoveError('remove_team_actor requires agent owner for personal agents', t)).toMatch(/owner can remove a personal agent/i)
  })

  it('maps team-agent admin-only error', () => {
    expect(formatActorRemoveError('remove_team_actor requires owner or admin for team agents', t)).toMatch(/remove team agents/i)
  })

  it('maps idea-activity FK blocker', () => {
    expect(formatActorRemoveError('agent_delete_blocked_by_idea_activities', t)).toMatch(/idea activity/i)
  })

  it('maps apps FK blocker', () => {
    expect(formatActorRemoveError('agent_delete_blocked_by_apps', t)).toMatch(/related apps/i)
  })

  it('maps files FK blocker', () => {
    expect(formatActorRemoveError('agent_delete_blocked_by_files', t)).toMatch(/related files/i)
  })

  it('maps generic reference blocker', () => {
    expect(formatActorRemoveError('actor_delete_blocked_by_references', t)).toMatch(/referenced elsewhere/i)
  })

  it('maps FK owner_member_id error', () => {
    expect(formatActorRemoveError('violates foreign key constraint "agents_owner_member_id_fkey"', t)).toMatch(/owns one or more agents/i)
  })

  it('falls back to generic message', () => {
    expect(formatActorRemoveError('something unexpected', t)).toBe('Remove failed: something unexpected')
  })
})
