import { beforeEach, describe, expect, it, vi } from 'vitest'

const workspaceState = vi.hoisted(() => ({ path: null as string | null }))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: workspaceState.path }) },
}))

const listLocalDaemonWorkspaces = vi.hoisted(() => vi.fn())
vi.mock('@/lib/local-daemon-workspaces', () => ({
  listLocalDaemonWorkspaces: () => listLocalDaemonWorkspaces(),
  defaultLocalDaemonWorkspacePath: (rows: Array<{ path: string; isDefault: boolean }>) =>
    rows.find((r) => r.isDefault)?.path ?? null,
}))

import { effectiveWorkspacePath, invalidateEffectiveWorkspacePath } from '../effective-workspace'

const DEFAULT_WS = '/Users/x/.amuxd/teams/team-1/workspace'

describe('effectiveWorkspacePath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateEffectiveWorkspacePath()
    workspaceState.path = null
    listLocalDaemonWorkspaces.mockResolvedValue([
      { path: '/projects/other', isDefault: false },
      { path: DEFAULT_WS, isDefault: true },
    ])
  })

  it('uses the open folder without asking the daemon', async () => {
    workspaceState.path = '/projects/mine'

    await expect(effectiveWorkspacePath()).resolves.toBe('/projects/mine')
    expect(listLocalDaemonWorkspaces).not.toHaveBeenCalled()
  })

  /**
   * The daemon runs in its own default workspace whenever nothing else is
   * picked — gateway sessions and global cron jobs already land there. So this
   * resolves to the config those runs actually read, instead of the panel
   * simply dying with no folder open.
   */
  it('falls back to the daemon default workspace', async () => {
    await expect(effectiveWorkspacePath()).resolves.toBe(DEFAULT_WS)
  })

  it('caches the fallback, and forgets it on invalidate', async () => {
    await effectiveWorkspacePath()
    await effectiveWorkspacePath()
    expect(listLocalDaemonWorkspaces).toHaveBeenCalledTimes(1)

    invalidateEffectiveWorkspacePath()
    await effectiveWorkspacePath()
    expect(listLocalDaemonWorkspaces).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent resolution', async () => {
    await Promise.all([effectiveWorkspacePath(), effectiveWorkspacePath()])
    expect(listLocalDaemonWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('reports null when the daemon has no default workspace', async () => {
    listLocalDaemonWorkspaces.mockResolvedValue([])
    await expect(effectiveWorkspacePath()).resolves.toBeNull()
  })

  it('survives a daemon that cannot be reached', async () => {
    listLocalDaemonWorkspaces.mockRejectedValue(new Error('daemon HTTP unavailable'))
    await expect(effectiveWorkspacePath()).resolves.toBeNull()
  })
})
