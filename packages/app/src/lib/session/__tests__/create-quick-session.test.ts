import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQuickSession } from '@/lib/session/create-quick-session'

const mocks = vi.hoisted(() => ({
  teamId: 'team-1' as string | null,
  target: null as { agentId: string; displayName: string; source: 'local' } | null,
  enterActorDraft: vi.fn(),
  requestComposerFocus: vi.fn(),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: mocks.teamId ? { id: mocks.teamId } : null }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/ws' }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      enterActorDraft: mocks.enterActorDraft,
      requestComposerFocus: mocks.requestComposerFocus,
    }),
  },
}))

vi.mock('@/lib/session/resolve-quick-chat-target', () => ({
  resolveQuickChatTarget: vi.fn(async () => mocks.target),
}))

describe('createQuickSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.teamId = 'team-1'
    mocks.target = { agentId: 'a1', displayName: 'Bot', source: 'local' }
  })

  it('fails with no_team when no team', async () => {
    mocks.teamId = null
    expect(await createQuickSession()).toEqual({ ok: false, reason: 'no_team' })
  })

  it('fails with no_agent when resolver returns null', async () => {
    mocks.target = null
    expect(await createQuickSession()).toEqual({ ok: false, reason: 'no_agent' })
  })

  it('fails with server_error when resolver throws', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/session/resolve-quick-chat-target')
    const boom = new Error('backend down')
    vi.mocked(resolveQuickChatTarget).mockRejectedValueOnce(boom)
    const result = await createQuickSession()
    expect(result).toEqual({ ok: false, reason: 'server_error', error: boom })
  })

  it('enters actor draft without creating a session', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/session/resolve-quick-chat-target')
    const result = await createQuickSession()
    expect(result).toEqual({ ok: true, agentDisplayName: 'Bot' })
    expect(mocks.enterActorDraft).toHaveBeenCalledWith({
      id: 'a1',
      displayName: 'Bot',
      kind: 'agent',
    })
    expect(mocks.requestComposerFocus).toHaveBeenCalled()
    expect(resolveQuickChatTarget).toHaveBeenCalled()
  })

  it('uses target override without calling resolver again', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/session/resolve-quick-chat-target')
    const override = { agentId: 'a2', displayName: 'Cloud', source: 'team_default' as const }
    const result = await createQuickSession(override)
    expect(result).toEqual({ ok: true, agentDisplayName: 'Cloud' })
    expect(resolveQuickChatTarget).not.toHaveBeenCalled()
    expect(mocks.enterActorDraft).toHaveBeenCalledWith({
      id: 'a2',
      displayName: 'Cloud',
      kind: 'agent',
    })
  })
})
