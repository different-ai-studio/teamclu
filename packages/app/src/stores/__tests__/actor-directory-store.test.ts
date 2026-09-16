import { describe, it, expect } from 'vitest'
import {
  isListableActor,
  mapCacheRow,
  patchMemberTeamRole,
  toActorKind,
  useActorDirectoryStore,
} from '@/stores/actor-directory-store'

describe('mapCacheRow', () => {
  it('maps ownerMemberId from libsql cache for personal-agent delete gating', () => {
    const row = mapCacheRow({
      id: 'agent-1',
      teamId: 'team-1',
      actorType: 'agent',
      displayName: 'My Bot',
      memberStatus: null,
      agentStatus: 'active',
      lastActiveAt: null,
      teamRole: null,
      agentVisibility: 'personal',
      ownerMemberId: 'member-42',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      syncedAt: '2026-01-01T00:00:00Z',
    })

    expect(row.actor_type).toBe('agent')
    expect(row.visibility).toBe('personal')
    expect(row.owner_member_id).toBe('member-42')
  })

  // Gateway contacts used to be flattened into `member` here, which put every
  // WeCom sender in the members list under the "Team" subtitle.
  it('keeps an external gateway contact as its own kind', () => {
    const row = mapCacheRow({
      id: 'ext-1',
      teamId: 'team-1',
      actorType: 'external',
      displayName: 'wodi9vSQAAU8frf71',
      memberStatus: null,
      agentStatus: null,
      lastActiveAt: '2026-08-18T00:00:00Z',
      teamRole: null,
      agentVisibility: null,
      ownerMemberId: null,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-18T00:00:00Z',
      syncedAt: '2026-08-18T00:00:00Z',
    })

    expect(row.actor_type).toBe('external')
  })
})

describe('toActorKind', () => {
  it('recognises the three real kinds', () => {
    expect(toActorKind('agent')).toBe('agent')
    expect(toActorKind('external')).toBe('external')
    expect(toActorKind('member')).toBe('member')
  })

  it('falls back to member for anything unknown', () => {
    // A kind added server-side that this build has never heard of still has to
    // render as something; a person is the safer default than an agent (which
    // would get agent-only affordances like "set as default agent").
    expect(toActorKind('role_agent')).toBe('member')
    expect(toActorKind(null)).toBe('member')
    expect(toActorKind(undefined)).toBe('member')
  })
})

describe('isListableActor', () => {
  it('keeps active agents', () => {
    expect(isListableActor({ actor_type: 'agent', agent_status: 'active' })).toBe(true)
  })

  it('drops retired agents — the cache is never swept, so a cold start would paint them', () => {
    expect(isListableActor({ actor_type: 'agent', agent_status: 'archived' })).toBe(false)
    expect(isListableActor({ actor_type: 'agent', agent_status: 'disabled' })).toBe(false)
  })

  it('keeps members and any row with no agent status', () => {
    expect(isListableActor({ actor_type: 'member', agent_status: null })).toBe(true)
    // A row cached before agent_status was carried must not vanish.
    expect(isListableActor({ actor_type: 'agent', agent_status: null })).toBe(true)
  })
})

describe('patchMemberTeamRole', () => {
  it('updates the member row in the directory slice', () => {
    useActorDirectoryStore.setState({
      byTeam: {
        'team-1': {
          actors: [{
            id: 'actor-b',
            actor_type: 'member',
            display_name: 'Bob',
            member_status: null,
            agent_status: null,
            last_active_at: null,
            team_role: 'member',
          }],
          loading: false,
          error: false,
          started: true,
        },
      },
    })
    patchMemberTeamRole('team-1', 'actor-b', 'admin')
    expect(useActorDirectoryStore.getState().byTeam['team-1'].actors[0].team_role).toBe('admin')
  })
})
