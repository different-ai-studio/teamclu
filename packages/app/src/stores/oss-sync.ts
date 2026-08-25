import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'

// Single source of truth for the active team id: the current-team store
// (backed by the Cloud API), NOT a local teamclu.json field. OSS sync commands
// now take teamId explicitly so it can never drift from the active team.
function activeTeamId(): string | null {
  return useCurrentTeamStore.getState().team?.id ?? null
}

// ---------------------------------------------------------------------------
// Types (matching Rust VersionInfo serde camelCase output)
// ---------------------------------------------------------------------------

export interface VersionInfo {
  version: number
  parentVersion: number
  contentHash: string | null
  size: number
  deleted: boolean
  createdBy: string | null
  createdByNodeId: string | null
  createdAt: string
  message: string | null
}

export interface VersionPage {
  versions: VersionInfo[]
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// State interface
//
// The desktop now proxies team-sync to the amuxd daemon. `oss_sync_status`
// returns the daemon's AGGREGATE status — no per-file detail, no dirty/total
// counts. The old `fileStates` / `recentFiles` / `dirtyCount` / `totalFiles` /
// `lastServerSeq` fields no longer exist.
// ---------------------------------------------------------------------------

export interface OssSyncState {
  /** Active team id (from the current-team store), null when no team. */
  teamId: string | null
  /** Daemon-reported share mode, or null when team-share isn't enabled. */
  mode: string | null
  syncing: boolean
  lastSyncAt: string | null
  /** Aggregate counters from the last daemon sync (may be zeros). */
  pulled: number
  pushed: number
  conflicts: number
  /**
   * Files the server listed that the daemon could not pull. Non-zero means the
   * sync cursor was deliberately held back and they will be retried — so a tick
   * with `failed > 0` is not "clean" even though it returned successfully.
   */
  failed: number
  lastError: string | null

  /**
   * Team sync is per TEAM, not per workspace: the daemon syncs
   * `~/.amuxd[-<brand>]/teams/<id>/shared`, which exists whether or not a folder
   * is open. `workspacePath` stays optional on these calls purely so the daemon
   * can repair that workspace's team links on the way through, and so the
   * desktop's team-secret self-heal has somewhere to read from.
   */
  refresh(workspacePath?: string | null): Promise<void>
  syncNow(workspacePath?: string | null): Promise<void>
  listVersions(
    workspacePath: string | null,
    path: string,
    cursor?: string | null,
  ): Promise<VersionPage>
  /**
   * Fetch a version's plaintext. The daemon does NOT yet support this — the
   * command returns an Err, which we surface as a rejected promise with a clear
   * message. Callers (history providers) already degrade to a "preview
   * unavailable" state on rejection rather than crashing.
   */
  getVersionContent(workspacePath: string | null, contentHash: string): Promise<string>
  restoreVersion(
    workspacePath: string | null,
    path: string,
    contentHash: string,
  ): Promise<void>
  resolveConflict(
    workspacePath: string | null,
    path: string,
    choice: 'keepRemote' | 'keepLocal',
  ): Promise<void>
}

// ---------------------------------------------------------------------------
// Rust command result shapes
// ---------------------------------------------------------------------------

// Daemon aggregate status (oss_sync_status).
interface SyncStatusResult {
  mode: string | null
  lastSyncAt: string | null
  syncing: boolean
  lastError: string | null
  pulled: number
  pushed: number
  conflicts: number
  failed?: number
}

interface SyncNowResult {
  pulled: number
  pushed: number
  conflicts: number
  failed?: number
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

export const useOssSyncStore = create<OssSyncState>((set, get) => ({
  teamId: null,
  mode: null,
  syncing: false,
  lastSyncAt: null,
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  failed: 0,
  lastError: null,

  async refresh(workspacePath?: string | null) {
    if (!isTauri()) return
    const teamId = activeTeamId()
    if (!teamId) {
      // No active team → nothing to report; keep an empty, non-error status.
      set({ teamId: null, mode: null, pulled: 0, pushed: 0, conflicts: 0 })
      return
    }
    try {
      const status = await invoke<SyncStatusResult>('oss_sync_status', {
        workspacePath: workspacePath ?? null,
        teamId,
      })
      set({
        teamId,
        mode: status.mode ?? null,
        lastSyncAt: status.lastSyncAt ?? null,
        syncing: status.syncing ?? false,
        pulled: status.pulled ?? 0,
        pushed: status.pushed ?? 0,
        conflicts: status.conflicts ?? 0,
        failed: status.failed ?? 0,
        lastError: status.lastError ?? null,
      })
    } catch (e) {
      set({ lastError: String(e) })
    }
  },

  async syncNow(workspacePath?: string | null) {
    if (!isTauri()) return
    const teamId = activeTeamId()
    if (!teamId) {
      set({ lastError: 'No active team to sync.' })
      return
    }
    set({ syncing: true, lastError: null })
    try {
      const result = await invoke<SyncNowResult>('oss_sync_now', {
        workspacePath: workspacePath ?? null,
        teamId,
      })
      set({
        pulled: result.pulled ?? 0,
        pushed: result.pushed ?? 0,
        conflicts: result.conflicts ?? 0,
        failed: result.failed ?? 0,
      })
      // Re-fetch status to get fresh lastSyncAt / mode from the daemon.
      await get().refresh(workspacePath)
    } catch (e) {
      set({ lastError: String(e) })
    } finally {
      set({ syncing: false })
    }
  },

  async listVersions(
    workspacePath: string | null,
    path: string,
    cursor?: string | null,
  ): Promise<VersionPage> {
    return invoke<VersionPage>('oss_sync_list_versions', {
      workspacePath,
      teamId: activeTeamId(),
      path,
      cursor: cursor ?? null,
    })
  },

  async getVersionContent(
    workspacePath: string | null,
    contentHash: string,
  ): Promise<string> {
    // The daemon does not yet support version content fetch; the command
    // returns an Err. Let it reject so the history UI shows "preview
    // unavailable" instead of attempting to render undefined content.
    return invoke<string>('oss_sync_get_version_content', {
      workspacePath,
      teamId: activeTeamId(),
      contentHash,
    })
  },

  async restoreVersion(workspacePath: string | null, path: string, contentHash: string) {
    await invoke<void>('oss_sync_restore_version', {
      workspacePath,
      teamId: activeTeamId(),
      path,
      contentHash,
    })
  },

  async resolveConflict(
    workspacePath: string | null,
    path: string,
    choice: 'keepRemote' | 'keepLocal',
  ) {
    await invoke<void>('oss_sync_resolve_conflict', {
      workspacePath,
      teamId: activeTeamId(),
      path,
      // Rust expects camelCase enum variant (serde rename_all = "camelCase")
      choice: choice === 'keepRemote' ? 'keepRemote' : 'keepLocal',
    })
  },
}))

// JWT bridge note: pushing the FC token into teamclu.json used to live here,
// then moved to `@/lib/jwt-bridge`. The daemon now self-supplies its FC JWT, so
// that bridge is a no-op (see jwt-bridge.ts).

// ---------------------------------------------------------------------------
// Tauri event listener — auto-update store on each daemon tick.
// ---------------------------------------------------------------------------

if (isTauri()) {
  // The backend may emit "oss-sync-status" with the daemon's aggregate shape.
  listen<{
    mode?: string | null
    lastSyncAt?: string | null
    syncing?: boolean
    pulled?: number
    pushed?: number
    conflicts?: number
    lastError?: string | null
  }>('oss-sync-status', (e) => {
    useOssSyncStore.setState((s) => ({
      ...s,
      ...(e.payload.mode !== undefined ? { mode: e.payload.mode } : {}),
      ...(e.payload.lastSyncAt !== undefined
        ? { lastSyncAt: e.payload.lastSyncAt }
        : {}),
      ...(e.payload.syncing !== undefined ? { syncing: e.payload.syncing } : {}),
      ...(e.payload.pulled !== undefined ? { pulled: e.payload.pulled } : {}),
      ...(e.payload.pushed !== undefined ? { pushed: e.payload.pushed } : {}),
      ...(e.payload.conflicts !== undefined
        ? { conflicts: e.payload.conflicts }
        : {}),
      ...(e.payload.lastError !== undefined
        ? { lastError: e.payload.lastError }
        : {}),
    }))
  }).catch((err) => console.warn('[oss-sync] event subscribe failed', err))
}
