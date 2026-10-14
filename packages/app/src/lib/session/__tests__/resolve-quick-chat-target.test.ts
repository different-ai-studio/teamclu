import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LocalAgentUnavailableError,
  resolveQuickChatTarget,
} from '@/lib/session/resolve-quick-chat-target'

const deps = vi.hoisted(() => ({
  isTauri: true,
  workspacePath: '/ws/teamclu' as string | null,
  localAgent: null as { id: string; displayName: string } | null,
  memberDefault: null as string | null,
  effectiveDefault: null as string | null,
  actorDisplayName: 'MACPRO',
  localThrows: false,
  effectiveThrows: false,
  localAgentEnabled: true,
  rememberedTeamId: null as string | null,
  rememberedActorId: null as string | null,
}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: {
    getState: () => ({
      enabled: deps.localAgentEnabled,
      loadEnabled: async () => deps.localAgentEnabled,
    }),
  },
}))

vi.mock('@/lib/daemon/daemon-onboarding-identity', () => ({
  readDaemonOnboardingIdentity: () =>
    deps.rememberedTeamId ? { teamId: deps.rememberedTeamId, userId: 'u1' } : null,
}))

vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => deps.rememberedActorId,
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => deps.isTauri,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonAgent: vi.fn(async () => {
    if (deps.localThrows) throw new Error('local lookup failed')
    return deps.localAgent
  }),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      getMemberDefaultAgent: vi.fn(async () => deps.memberDefault),
      getEffectiveDefaultAgent: vi.fn(async () => {
        if (deps.effectiveThrows) throw new Error('effective lookup failed')
        return deps.effectiveDefault
      }),
      getActorDirectoryEntry: vi.fn(async (id: string) => ({
        id,
        display_name: deps.actorDisplayName,
      })),
    },
  }),
}))

describe('resolveQuickChatTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deps.isTauri = true
    deps.workspacePath = '/ws/teamclu'
    deps.localAgent = null
    deps.memberDefault = null
    deps.effectiveDefault = null
    deps.actorDisplayName = 'MACPRO'
    deps.localThrows = false
    deps.effectiveThrows = false
    deps.localAgentEnabled = true
    deps.rememberedTeamId = null
    deps.rememberedActorId = null
  })

  it('returns local when tauri + workspace + local agent bound', async () => {
    deps.localAgent = { id: 'agent-local', displayName: 'My Daemon' }
    const result = await resolveQuickChatTarget('team-1', { workspacePath: deps.workspacePath })
    expect(result).toEqual({
      agentId: 'agent-local',
      displayName: 'My Daemon',
      source: 'local',
    })
  })

  it('prefers the local agent over the team default even when no workspace path is set', async () => {
    // A new chat must always target THIS machine's local agent when one exists,
    // never the team/member default — regardless of the active workspace.
    deps.localAgent = { id: 'agent-local', displayName: 'My Daemon' }
    deps.memberDefault = 'agent-member'
    deps.effectiveDefault = 'agent-member'
    const result = await resolveQuickChatTarget('team-1', { workspacePath: null })
    expect(result?.source).toBe('local')
    expect(result?.agentId).toBe('agent-local')
  })

  it('uses the local agent even over a member default naming another agent', async () => {
    deps.localAgent = { id: 'agent-local', displayName: 'My Daemon' }
    deps.memberDefault = 'agent-other'
    deps.effectiveDefault = 'agent-other'
    const result = await resolveQuickChatTarget('team-1')
    expect(result).toMatchObject({ agentId: 'agent-local', source: 'local' })
  })

  it('opens on the remembered local agent while the daemon is down', async () => {
    deps.rememberedTeamId = 'team-1'
    deps.rememberedActorId = 'agent-remembered'
    deps.effectiveDefault = 'agent-team'
    const result = await resolveQuickChatTarget('team-1', { waitMs: 0 })
    expect(result).toEqual({ agentId: 'agent-remembered', displayName: 'MACPRO', source: 'local' })
  })

  it('does not trust a remembered agent from another team', async () => {
    deps.rememberedTeamId = 'team-other'
    deps.rememberedActorId = 'agent-remembered'
    deps.effectiveDefault = 'agent-team'
    await expect(resolveQuickChatTarget('team-1', { waitMs: 0 })).rejects.toBeInstanceOf(
      LocalAgentUnavailableError,
    )
  })

  it('never falls back to a remote default while enabled, even when the lookup throws', async () => {
    deps.localThrows = true
    deps.effectiveDefault = 'agent-team'
    await expect(resolveQuickChatTarget('team-1', { waitMs: 0 })).rejects.toBeInstanceOf(
      LocalAgentUnavailableError,
    )
  })

  it('waits for the daemon and takes the local agent once it answers', async () => {
    vi.useFakeTimers()
    try {
      const pending = resolveQuickChatTarget('team-1', { waitMs: 5_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      deps.localAgent = { id: 'agent-local', displayName: 'My Daemon' }
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toMatchObject({ agentId: 'agent-local', source: 'local' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the wait and reports the local agent unavailable', async () => {
    vi.useFakeTimers()
    try {
      const pending = resolveQuickChatTarget('team-1', { waitMs: 3_000 })
      const assertion = expect(pending).rejects.toBeInstanceOf(LocalAgentUnavailableError)
      await vi.advanceTimersByTimeAsync(4_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  describe('with the local agent disabled', () => {
    beforeEach(() => {
      deps.localAgentEnabled = false
      // A daemon that still answers must not be used once disabled.
      deps.localAgent = { id: 'agent-local', displayName: 'My Daemon' }
    })

    it('returns member_default', async () => {
      deps.memberDefault = 'agent-member'
      deps.effectiveDefault = 'agent-member'
      const result = await resolveQuickChatTarget('team-1')
      expect(result?.source).toBe('member_default')
    })

    it('returns team_default when only team default set', async () => {
      deps.effectiveDefault = 'agent-team'
      const result = await resolveQuickChatTarget('team-1')
      expect(result?.source).toBe('team_default')
      expect(result?.agentId).toBe('agent-team')
    })

    it('returns null when nothing available', async () => {
      const result = await resolveQuickChatTarget('team-1')
      expect(result).toBeNull()
    })
  })

  it('never uses local on non-tauri even if local agent mock set', async () => {
    deps.isTauri = false
    deps.localAgent = { id: 'agent-local', displayName: 'X' }
    deps.effectiveDefault = 'agent-cloud'
    deps.memberDefault = null
    const result = await resolveQuickChatTarget('team-1', { workspacePath: '/ws' })
    expect(result?.source).toBe('team_default')
  })
})
