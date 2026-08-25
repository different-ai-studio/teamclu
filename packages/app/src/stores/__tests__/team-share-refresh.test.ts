import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: async () => 'access-token',
}))
vi.mock('@/lib/server-config', () => ({
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: 'https://api.example.test' }),
}))

import { useTeamShareStore } from '../team-share'

describe('team-share refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTeamShareStore.setState({
      status: { mode: null, enabledAt: null },
      loading: false,
      lastError: null,
    })
    mockInvoke.mockResolvedValue({ mode: 'oss', enabledAt: '2026-06-01T00:00:00Z' })
  })

  /**
   * Share mode is the TEAM's and comes from the Cloud API — a workspace only
   * decorates the result with its own `linkStatus`. This used to be gated on a
   * workspace being open, and since this is the only place the status is ever
   * loaded, a client with no folder open reported "share is off" for a team
   * where it is on: no shared-files tab, a greyed-out sync button, no nav counts.
   */
  it('reads the team share mode with no workspace open', async () => {
    const status = await useTeamShareStore.getState().refresh('team-1', null)

    expect(mockInvoke).toHaveBeenCalledWith('team_share_get_status', {
      teamId: 'team-1',
      workspacePath: null,
      accessToken: 'access-token',
      cloudApiUrl: 'https://api.example.test',
    })
    expect(status.mode).toBe('oss')
    expect(useTeamShareStore.getState().status.mode).toBe('oss')
    // Nothing to describe: there is no single workspace whose link this is.
    expect(status.linkStatus).toBeUndefined()
  })

  it('still passes a workspace through when there is one', async () => {
    mockInvoke.mockResolvedValue({ mode: 'oss', linkStatus: 'symlink' })

    const status = await useTeamShareStore.getState().refresh('team-1', '/ws')

    expect(mockInvoke).toHaveBeenCalledWith(
      'team_share_get_status',
      expect.objectContaining({ workspacePath: '/ws' }),
    )
    expect(status.linkStatus).toBe('symlink')
  })

  it('coalesces concurrent reads for the same team', async () => {
    const [a, b] = await Promise.all([
      useTeamShareStore.getState().refresh('team-1', null),
      useTeamShareStore.getState().refresh('team-1', null),
    ])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })
})
