import { describe, it, expect } from 'vitest'
import { canRemoveTeamActor, permissionsForRole } from '@/lib/team/team-permissions'
import type { RemovableActorTarget } from '@/lib/team/team-permissions'

describe('permissionsForRole', () => {
  it('owner can do everything', () => {
    expect(permissionsForRole('owner')).toEqual({
      role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true,
    })
  })
  it('admin manages + edits but is not owner', () => {
    expect(permissionsForRole('admin')).toEqual({
      role: 'admin', isOwner: false, canManageTeam: true, canEditFiles: true,
    })
  })
  it('member is read-only and cannot manage', () => {
    expect(permissionsForRole('member')).toEqual({
      role: 'member', isOwner: false, canManageTeam: false, canEditFiles: false,
    })
  })
  it('null / unknown role: no team — management denied, editing allowed (solo case)', () => {
    expect(permissionsForRole(null)).toEqual({
      role: null, isOwner: false, canManageTeam: false, canEditFiles: true,
    })
    expect(permissionsForRole('bogus')).toEqual({
      role: null, isOwner: false, canManageTeam: false, canEditFiles: true,
    })
  })
  it('normalizes case', () => {
    expect(permissionsForRole('Owner').isOwner).toBe(true)
  })
})

describe('canRemoveTeamActor', () => {
  const adminPerms = permissionsForRole('admin')
  const memberPerms = permissionsForRole('member')

  const memberTarget: RemovableActorTarget = {
    id: 'actor-b',
    actor_type: 'member',
  }

  it('allows admin/owner to remove another member', () => {
    expect(canRemoveTeamActor(adminPerms, memberTarget, 'actor-a')).toBe(true)
  })

  it('denies non-managers removing members', () => {
    expect(canRemoveTeamActor(memberPerms, memberTarget, 'actor-a')).toBe(false)
  })

  it('denies removing self', () => {
    expect(canRemoveTeamActor(adminPerms, { ...memberTarget, id: 'actor-a' }, 'actor-a')).toBe(false)
  })

  it('denies when current member is unknown', () => {
    expect(canRemoveTeamActor(adminPerms, memberTarget, null)).toBe(false)
  })

  it('allows personal agent owner to remove their agent', () => {
    const personalAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'personal',
      owner_member_id: 'actor-a',
    }
    expect(canRemoveTeamActor(memberPerms, personalAgent, 'actor-a')).toBe(true)
  })

  it('denies non-owner removing personal agent', () => {
    const personalAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'personal',
      owner_member_id: 'actor-b',
    }
    expect(canRemoveTeamActor(memberPerms, personalAgent, 'actor-a')).toBe(false)
  })

  it('allows admin to remove team agent', () => {
    const teamAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'team',
      owner_member_id: 'actor-b',
    }
    expect(canRemoveTeamActor(adminPerms, teamAgent, 'actor-a')).toBe(true)
  })

  it('denies member removing team agent', () => {
    const teamAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'team',
      owner_member_id: 'actor-b',
    }
    expect(canRemoveTeamActor(memberPerms, teamAgent, 'actor-a')).toBe(false)
  })

  it('allows owner to remove team agent', () => {
    const teamAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'team',
      owner_member_id: 'actor-b',
    }
    expect(canRemoveTeamActor(permissionsForRole('owner'), teamAgent, 'actor-a')).toBe(true)
  })

  it('requires owner_member_id for personal agent delete', () => {
    const personalAgent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: 'personal',
      owner_member_id: null,
    }
    expect(canRemoveTeamActor(memberPerms, personalAgent, 'actor-a')).toBe(false)
  })

  it('denies delete when agent visibility is unknown (cold cache)', () => {
    const agent: RemovableActorTarget = {
      id: 'agent-1',
      actor_type: 'agent',
      visibility: null,
      owner_member_id: 'actor-a',
    }
    expect(canRemoveTeamActor(adminPerms, agent, 'actor-a')).toBe(false)
    expect(canRemoveTeamActor(memberPerms, agent, 'actor-a')).toBe(false)
  })
})
