import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: 'team-1' } }) },
}))
vi.mock('@/lib/team-skill-paths', () => ({
  globalTeamSyncShareRoot: () => Promise.resolve('/home/u/.amuxd/teams/team-1/shared/team-sync'),
}))

const syncNow = vi.fn(() => Promise.resolve())
vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: { getState: () => ({ syncNow }) },
}))

const { useTeamConflictsStore } = await import('../team-conflicts')

const SIDECAR = 'knowledge/.conflicts/note.conflict.1000.aabbccdd.md'
const OLDER = 'knowledge/.conflicts/note.conflict.900.eeeeeeee.md'

function entry(sidecar: string, conflictedAt: number) {
  return { path: 'knowledge/note.md', sidecar, conflictedAt, kind: 'oss-sidecar' }
}

beforeEach(() => {
  invoke.mockReset()
  syncNow.mockClear()
  useTeamConflictsStore.setState({ entries: [], bySyncKey: {}, syncRoot: null, error: null })
})

describe('team-conflicts store', () => {
  it('loads conflicts grouped by the DOCUMENT, not the sidecar', async () => {
    invoke.mockResolvedValueOnce([entry(SIDECAR, 1000), entry(OLDER, 900)])

    await useTeamConflictsStore.getState().load()

    expect(invoke).toHaveBeenCalledWith('team_conflicts', { teamId: 'team-1' })
    const { bySyncKey, entries } = useTeamConflictsStore.getState()
    expect(entries).toHaveLength(2)
    // One row in the tree, two decisions behind it.
    expect(Object.keys(bySyncKey)).toEqual(['knowledge/note.md'])
    expect(bySyncKey['knowledge/note.md']).toHaveLength(2)
  })

  it('maps a sync key onto this device knowledge dir', async () => {
    invoke.mockResolvedValueOnce([entry(SIDECAR, 1000)])
    await useTeamConflictsStore.getState().load()

    expect(useTeamConflictsStore.getState().absPathFor(SIDECAR)).toBe(
      '/home/u/.amuxd/teams/team-1/shared/team-sync/knowledge/.conflicts/note.conflict.1000.aabbccdd.md',
    )
    // Anything outside the knowledge prefix is not ours to place.
    expect(useTeamConflictsStore.getState().absPathFor('skills/x.md')).toBeNull()
  })

  it('names the sidecar when resolving, and syncs after keeping the local copy', async () => {
    invoke.mockResolvedValueOnce([entry(SIDECAR, 1000)])
    await useTeamConflictsStore.getState().load()
    invoke.mockReset()
    invoke.mockResolvedValueOnce(undefined) // resolve
    invoke.mockResolvedValueOnce([]) // reload

    await useTeamConflictsStore.getState().resolve(entry(SIDECAR, 1000), 'keepLocal')

    expect(invoke).toHaveBeenCalledWith('team_resolve_conflict', {
      teamId: 'team-1',
      path: 'knowledge/note.md',
      sidecar: SIDECAR,
      choice: 'keepLocal',
    })
    // The restored copy only exists on this disk until a push carries it up.
    expect(syncNow).toHaveBeenCalled()
    expect(useTeamConflictsStore.getState().entries).toEqual([])
  })

  it('does not sync when the cloud copy was the one kept', async () => {
    invoke.mockResolvedValueOnce(undefined)
    invoke.mockResolvedValueOnce([])

    await useTeamConflictsStore.getState().resolve(entry(SIDECAR, 1000), 'keepRemote')

    expect(syncNow).not.toHaveBeenCalled()
  })

  it('reports the failure instead of leaving a stale list', async () => {
    invoke.mockRejectedValueOnce(new Error('daemon down'))
    await useTeamConflictsStore.getState().load()
    expect(useTeamConflictsStore.getState().error).toContain('daemon down')
    expect(useTeamConflictsStore.getState().loading).toBe(false)
  })
})
