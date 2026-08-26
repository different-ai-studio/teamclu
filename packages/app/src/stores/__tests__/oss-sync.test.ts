import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn()
const mockListen = vi.fn(() => Promise.resolve(() => {}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

// The store resolves the active team id from the current-team store and now
// passes `teamId` to every OSS sync command (refactor ad563711). Provide a
// stable active team so the team-guarded paths run and invoke is reached.
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-active' } }),
  },
}))

// ── Import store after mocks ──────────────────────────────────────────────

const { useOssSyncStore } = await import('../oss-sync')

// ── Helpers ───────────────────────────────────────────────────────────────

function resetState() {
  useOssSyncStore.setState({
    syncing: false,
    lastSyncAt: null,
    teamId: null,
    mode: null,
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    lastError: null,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
  mockListen.mockReturnValue(Promise.resolve(() => {}))
  resetState()
})

describe('useOssSyncStore', () => {
  // ── refresh ──────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('updates aggregate status from oss_sync_status', async () => {
      // Daemon aggregate shape: no teamId field — the store keeps the active
      // team id from the current-team store.
      mockInvoke.mockResolvedValueOnce({
        mode: 'oss',
        lastSyncAt: '2026-05-27T12:00:00Z',
        syncing: false,
        lastError: null,
        pulled: 3,
        pushed: 1,
        conflicts: 0,
      })

      await useOssSyncStore.getState().refresh('/workspace/path')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_status', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
      })
      const state = useOssSyncStore.getState()
      expect(state.teamId).toBe('team-active')
      expect(state.mode).toBe('oss')
      expect(state.lastSyncAt).toBe('2026-05-27T12:00:00Z')
      expect(state.pulled).toBe(3)
      expect(state.pushed).toBe(1)
      expect(state.conflicts).toBe(0)
      expect(state.lastError).toBeNull()
    })

    it('sets lastError on failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('network error'))

      await useOssSyncStore.getState().refresh('/workspace/path')

      expect(useOssSyncStore.getState().lastError).toMatch('network error')
    })
  })

  // ── syncNow ──────────────────────────────────────────────────────────────

  describe('syncNow', () => {
    it('flips syncing true then false on success', async () => {
      const syncResult = { pulled: 2, pushed: 1, conflicts: 0 }
      const statusResult = {
        mode: 'oss',
        lastSyncAt: '2026-05-27T13:00:00Z',
        syncing: false,
        lastError: null,
        pulled: 2,
        pushed: 1,
        conflicts: 0,
      }

      const syncingValues: boolean[] = []
      useOssSyncStore.subscribe((state) => {
        syncingValues.push(state.syncing)
      })

      mockInvoke
        .mockResolvedValueOnce(syncResult) // oss_sync_now
        .mockResolvedValueOnce(statusResult) // oss_sync_status (refresh)

      await useOssSyncStore.getState().syncNow('/workspace/path')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_now', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        // Explicitly false, not omitted: this flag is a person's answer to
        // "you added N files at once — send them?", and a default-on anywhere
        // would quietly remove the guard.
        allowBulkAdd: false,
      })
      expect(useOssSyncStore.getState().syncing).toBe(false)
      expect(useOssSyncStore.getState().lastError).toBeNull()
    })

    it('sets lastError and clears syncing on throw', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('sync failed'))

      await useOssSyncStore.getState().syncNow('/workspace/path')

      const state = useOssSyncStore.getState()
      expect(state.syncing).toBe(false)
      expect(state.lastError).toMatch('sync failed')
    })
  })

  // ── listVersions ─────────────────────────────────────────────────────────

  describe('listVersions', () => {
    it('calls oss_sync_list_versions with cursor and returns a version page', async () => {
      const page = {
        versions: [
          {
            version: 2,
            contentHash: 'abc123',
            size: 512,
            deleted: false,
            createdAt: '2026-05-27T10:00:00Z',
            message: null,
          },
          {
            version: 1,
            contentHash: 'def456',
            size: 480,
            deleted: false,
            createdAt: '2026-05-26T10:00:00Z',
            message: 'initial',
          },
        ],
        nextCursor: null,
      }
      mockInvoke.mockResolvedValueOnce(page)

      const result = await useOssSyncStore
        .getState()
        .listVersions('/workspace/path', 'notes/foo.md')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_list_versions', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        path: 'notes/foo.md',
        cursor: null,
      })
      expect(result.versions).toHaveLength(2)
      expect(result.versions[0].contentHash).toBe('abc123')
      expect(result.nextCursor).toBeNull()
    })

    it('forwards an explicit cursor to oss_sync_list_versions', async () => {
      mockInvoke.mockResolvedValueOnce({ versions: [], nextCursor: null })

      await useOssSyncStore
        .getState()
        .listVersions('/workspace/path', 'notes/foo.md', 'CURSOR1')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_list_versions', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        path: 'notes/foo.md',
        cursor: 'CURSOR1',
      })
    })
  })

  // ── restoreVersion ───────────────────────────────────────────────────────

  describe('restoreVersion', () => {
    it('calls oss_sync_restore_version with correct args', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .restoreVersion('/workspace/path', 'notes/foo.md', 'abc123')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_restore_version', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        path: 'notes/foo.md',
        contentHash: 'abc123',
      })
    })
  })

  // ── resolveConflict ──────────────────────────────────────────────────────

  describe('resolveConflict', () => {
    it('calls oss_sync_resolve_conflict with keepRemote', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .resolveConflict('/workspace/path', 'notes/foo.md', 'keepRemote')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_resolve_conflict', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        path: 'notes/foo.md',
        choice: 'keepRemote',
      })
    })

    it('calls oss_sync_resolve_conflict with keepLocal', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .resolveConflict('/workspace/path', 'notes/foo.md', 'keepLocal')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_resolve_conflict', {
        workspacePath: '/workspace/path',
        teamId: 'team-active',
        path: 'notes/foo.md',
        choice: 'keepLocal',
      })
    })
  })
})
