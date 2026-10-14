import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveQuickChatTarget } from '@/lib/session/resolve-quick-chat-target'

const deps = vi.hoisted(() => ({
  isTauri: true,
  workspacePath: '/ws/teamclu' as string | null,
  localAgent: null as { id: string; displayName: string } | null,
  memberDefault: null as string | null,
  effectiveDefault: null as string | null,
  actorDisplayName: 'MACPRO',
  localThrows: false,
  effectiveThrows: false,
  install: { status: 'unknown' as 'unknown' | 'absent' | 'installed', agentId: null as string | null, displayName: null as string | null },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => deps.isTauri,
}))

vi.mock('@/lib/daemon/local-agent-install', () => ({
  resolveLocalAgentInstall: vi.fn(async () => deps.install),
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
    deps.install = { status: 'unknown', agentId: null, displayName: null }
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

  it('returns member_default when no local agent', async () => {
    deps.memberDefault = 'agent-member'
    deps.effectiveDefault = 'agent-member'
    const result = await resolveQuickChatTarget('team-1', { workspacePath: deps.workspacePath })
    expect(result?.source).toBe('member_default')
  })

  it('returns team_default when only team default set', async () => {
    deps.memberDefault = null
    deps.effectiveDefault = 'agent-team'
    const result = await resolveQuickChatTarget('team-1', { workspacePath: null })
    expect(result?.source).toBe('team_default')
    expect(result?.agentId).toBe('agent-team')
  })

  it('returns null when nothing available', async () => {
    const result = await resolveQuickChatTarget('team-1', { workspacePath: null })
    expect(result).toBeNull()
  })

  it('never uses local on non-tauri even if local agent mock set', async () => {
    deps.isTauri = false
    deps.localAgent = { id: 'agent-local', displayName: 'X' }
    deps.effectiveDefault = 'agent-cloud'
    deps.memberDefault = null
    const result = await resolveQuickChatTarget('team-1', { workspacePath: '/ws' })
    expect(result?.source).toBe('team_default')
  })

  it('falls through to effective when local lookup throws and install state is unknown', async () => {
    deps.localThrows = true
    deps.effectiveDefault = 'agent-team'
    const result = await resolveQuickChatTarget('team-1', { workspacePath: '/ws' })
    expect(result?.source).toBe('team_default')
    expect(result?.agentId).toBe('agent-team')
  })

  it('stays on the installed agent when the local daemon does not answer', async () => {
    deps.localThrows = true
    deps.effectiveDefault = 'agent-team'
    deps.install = { status: 'installed', agentId: 'agent-local', displayName: 'This machine' }
    const result = await resolveQuickChatTarget('team-1', { workspacePath: '/ws' })
    expect(result).toEqual({
      agentId: 'agent-local',
      displayName: 'This machine',
      source: 'local',
    })
  })

  it('falls through when this machine has never installed a local agent', async () => {
    deps.install = { status: 'absent', agentId: null, displayName: null }
    deps.effectiveDefault = 'agent-team'
    const result = await resolveQuickChatTarget('team-1', { workspacePath: '/ws' })
    expect(result?.source).toBe('team_default')
    expect(result?.agentId).toBe('agent-team')
  })
})
