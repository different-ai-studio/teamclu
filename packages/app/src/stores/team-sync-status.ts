import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'

/** What this device has that the cloud does not. */
export type LocalChangeStatus = 'new' | 'modified' | 'deleted'

interface RemotePendingItem {
  version: number
  deleted: boolean
}

/**
 * How long a remote probe stays fresh. The probe is a real FC round-trip, so it
 * runs on events (panel shown, window focused, manual refresh) and this keeps
 * those events from turning into a poll when they arrive in bursts.
 */
const REMOTE_TTL_MS = 60_000

interface TeamSyncStatusState {
  /** Sync key → what changed here. Pure disk scan through the daemon, no network. */
  localBySyncKey: Record<string, LocalChangeStatus>
  /** Sync key → the version waiting in the cloud. One FC round-trip to fill. */
  remoteBySyncKey: Record<string, RemotePendingItem>
  /** `Date.now()` of the last successful remote probe. */
  remoteCheckedAt: number
  loading: boolean
  error: string | null

  /** Free: what is on this disk that has not gone up yet. */
  loadLocal(): Promise<void>
  /** Costs one FC round-trip; skipped inside the TTL unless forced. */
  loadRemote(opts?: { force?: boolean }): Promise<void>
  /** Both, for "the panel just became visible" and "the user asked". */
  refresh(opts?: { force?: boolean }): Promise<void>
  /**
   * A sync just finished, so whatever was waiting in the cloud is now here.
   * Clearing locally beats spending another round-trip to be told the same.
   */
  clearRemote(): void
  reset(): void
}

export const useTeamSyncStatusStore = create<TeamSyncStatusState>((set, get) => ({
  localBySyncKey: {},
  remoteBySyncKey: {},
  remoteCheckedAt: 0,
  loading: false,
  error: null,

  async loadLocal() {
    if (!isTauri()) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) {
      set({ localBySyncKey: {} })
      return
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ files: { path: string; status: LocalChangeStatus }[] }>(
        'team_changed_files',
        { teamId },
      )
      const next: Record<string, LocalChangeStatus> = {}
      for (const f of res.files ?? []) next[f.path] = f.status
      set({ localBySyncKey: next, error: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async loadRemote(opts) {
    if (!isTauri()) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) {
      set({ remoteBySyncKey: {} })
      return
    }
    if (!opts?.force && Date.now() - get().remoteCheckedAt < REMOTE_TTL_MS) return
    set({ loading: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{
        items: { path: string; version: number; deleted: boolean }[]
      }>('team_remote_pending', { teamId })
      const next: Record<string, RemotePendingItem> = {}
      for (const item of res.items ?? []) {
        next[item.path] = { version: item.version, deleted: item.deleted }
      }
      set({
        remoteBySyncKey: next,
        remoteCheckedAt: Date.now(),
        loading: false,
        error: null,
      })
    } catch (e) {
      // Offline, no cloud backend, daemon down — all of which mean "cannot tell
      // right now", not "nothing pending". Keeping the previous answer beats
      // claiming the cloud is in sync.
      set({ loading: false, error: String(e) })
    }
  },

  async refresh(opts) {
    await Promise.all([get().loadLocal(), get().loadRemote(opts)])
  },

  clearRemote() {
    set({ remoteBySyncKey: {}, remoteCheckedAt: Date.now() })
  },

  reset() {
    set({ localBySyncKey: {}, remoteBySyncKey: {}, remoteCheckedAt: 0, error: null })
  },
}))
