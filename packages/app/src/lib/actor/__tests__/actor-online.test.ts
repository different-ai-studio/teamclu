import { beforeEach, describe, expect, it } from 'vitest'
import { resolveActorOnlineStatus } from '@/lib/actor/actor-online'
import { __resetLocalDaemonSignalCacheForTest } from '@/lib/agent/agent-device-reachability'
import { __resetLocalDaemonIdentityForTest } from '@/lib/daemon/local-daemon-identity'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

describe('resolveActorOnlineStatus', () => {
  const member = {
    id: 'member-1',
    actor_type: 'member' as const,
    last_active_at: '2020-01-01T00:00:00.000Z',
  }

  beforeEach(() => {
    __resetLocalDaemonSignalCacheForTest()
    __resetLocalDaemonIdentityForTest()
    useActorPresenceStore.setState({ byActorId: {} })
  })

  it('treats the current member as online even when last_active_at is stale', () => {
    expect(resolveActorOnlineStatus(member, { currentMemberActorId: 'member-1' })).toBe(true)
  })

  it('uses last_active_at for other members', () => {
    expect(resolveActorOnlineStatus(member, { currentMemberActorId: 'member-2' })).toBe(false)
  })

  it('falls back to agentPresence when MQTT store has no retain', () => {
    const agent = { id: 'agent-1', actor_type: 'agent' as const, last_active_at: null }
    expect(resolveActorOnlineStatus(agent, { agentPresence: { online: true } })).toBe(true)
    expect(resolveActorOnlineStatus(agent, { agentPresence: { online: false } })).toBe(false)
  })

  it('prefers shared device-presence merge from the MQTT store', () => {
    const agent = { id: 'agent-1', actor_type: 'agent' as const, last_active_at: null }
    useActorPresenceStore.getState().upsert('agent-1', {
      online: true,
      displayName: 'a',
      lastUpdated: Date.now(),
    })
    expect(resolveActorOnlineStatus(agent, { agentPresence: { online: false } })).toBe(true)
  })
})
