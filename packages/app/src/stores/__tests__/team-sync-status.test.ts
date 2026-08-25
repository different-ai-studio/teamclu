import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: 'team-1' } }) },
}))

const { useTeamSyncStatusStore } = await import('../team-sync-status')

beforeEach(() => {
  invoke.mockReset()
  useTeamSyncStatusStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('team-sync-status store', () => {
  it('keys local changes by sync key', async () => {
    invoke.mockResolvedValueOnce({
      files: [
        { path: 'knowledge/a.md', status: 'new' },
        { path: 'knowledge/b.md', status: 'modified' },
      ],
    })

    await useTeamSyncStatusStore.getState().loadLocal()

    expect(invoke).toHaveBeenCalledWith('team_changed_files', { teamId: 'team-1' })
    expect(useTeamSyncStatusStore.getState().localBySyncKey).toEqual({
      'knowledge/a.md': 'new',
      'knowledge/b.md': 'modified',
    })
  })

  it('probes the cloud once per minute, however often it is asked', async () => {
    invoke.mockResolvedValue({ items: [{ path: 'knowledge/x.md', version: 3, deleted: false }] })

    await useTeamSyncStatusStore.getState().loadRemote()
    await useTeamSyncStatusStore.getState().loadRemote()
    await useTeamSyncStatusStore.getState().loadRemote()

    // Every call is a real FC round-trip, which is why the panel is allowed to
    // ask on every focus without turning into a poll.
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useTeamSyncStatusStore.getState().remoteBySyncKey).toEqual({
      'knowledge/x.md': { version: 3, deleted: false },
    })
  })

  it('goes out again when the user explicitly asks', async () => {
    invoke.mockResolvedValue({ items: [] })

    await useTeamSyncStatusStore.getState().loadRemote()
    await useTeamSyncStatusStore.getState().loadRemote({ force: true })

    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer when the probe fails', async () => {
    invoke.mockResolvedValueOnce({ items: [{ path: 'knowledge/x.md', version: 3, deleted: false }] })
    await useTeamSyncStatusStore.getState().loadRemote()

    invoke.mockRejectedValueOnce(new Error('offline'))
    await useTeamSyncStatusStore.getState().loadRemote({ force: true })

    // "Cannot tell right now" is not "you are in sync" — dropping the list
    // would quietly clear every blue badge the moment the network blinked.
    expect(useTeamSyncStatusStore.getState().remoteBySyncKey).toEqual({
      'knowledge/x.md': { version: 3, deleted: false },
    })
    expect(useTeamSyncStatusStore.getState().error).toContain('offline')
  })

  it('empties the pending list after a sync instead of asking again', async () => {
    invoke.mockResolvedValueOnce({ items: [{ path: 'knowledge/x.md', version: 3, deleted: false }] })
    await useTeamSyncStatusStore.getState().loadRemote()
    invoke.mockClear()

    useTeamSyncStatusStore.getState().clearRemote()

    expect(useTeamSyncStatusStore.getState().remoteBySyncKey).toEqual({})
    expect(invoke).not.toHaveBeenCalled()
  })
})
