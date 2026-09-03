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

/** How far the running daemon tick has got (`GET /v1/team/sync/status`). */
interface SyncProgress {
  phase: 'checking' | 'pulling' | 'pushing' | 'deleting'
  done: number
  /** `0` means the phase cannot say — render indeterminate, not 0%. */
  total: number
}

interface VersionPage {
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

interface OssSyncState {
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
  /**
   * Paths the last tick refused to upload for exceeding the per-file size
   * limit. The tick still succeeded — but silence here would leave the user
   * believing these went up.
   */
  oversize: string[]
  /**
   * How many new files the last tick held back, waiting to be told to send
   * them. `null` on a normal tick. Non-null means NOTHING was pushed, so the
   * bar has to ask rather than just report.
   */
  blockedNewFiles: number | null
  lastError: string | null
  /**
   * Live progress of the running tick, `null` when nothing is running. The
   * daemon omits the field entirely when idle, so this never shows a finished
   * sync's last position.
   */
  progress: SyncProgress | null

  /**
   * Team sync is per TEAM, not per workspace: the daemon syncs
   * `~/.amuxd[-<brand>]/teams/<id>/shared`, which exists whether or not a folder
   * is open. `workspacePath` stays optional on these calls purely so the daemon
   * can repair that workspace's team links on the way through, and so the
   * desktop's team-secret self-heal has somewhere to read from.
   */
  refresh(workspacePath?: string | null): Promise<void>
  /**
   * `allowBulkAdd` answers the "you added N files at once — send them?"
   * question. Never pass it on a retry or a timer: that turns the guard into a
   * one-tick delay.
   */
  syncNow(workspacePath?: string | null, opts?: { allowBulkAdd?: boolean }): Promise<void>
  listVersions(
    workspacePath: string | null,
    path: string,
    cursor?: string | null,
  ): Promise<VersionPage>
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
  progress?: SyncProgress | null
}

interface SyncNowResult {
  pulled: number
  pushed: number
  conflicts: number
  failed?: number
  oversize?: string[]
  blockedNewFiles?: number | null
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

/**
 * True while THIS app is waiting on `oss_sync_now`. Module-scoped rather than
 * store state: it exists only to keep a concurrent status poll from clearing
 * `syncing` mid-flight, and nothing renders it.
 */
let localSyncInFlight = false

export const useOssSyncStore = create<OssSyncState>((set, get) => ({
  teamId: null,
  mode: null,
  syncing: false,
  lastSyncAt: null,
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  failed: 0,
  oversize: [],
  blockedNewFiles: null,
  lastError: null,
  progress: null,

  async refresh(workspacePath?: string | null) {
    if (!isTauri()) return
    const teamId = activeTeamId()
    if (!teamId) {
      // No active team → nothing to report; keep an empty, non-error status.
      set({ teamId: null, mode: null, pulled: 0, pushed: 0, conflicts: 0, progress: null })
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
        // A status poll must not switch the indicator off underneath a sync
        // this app started: the daemon flips `syncing` a moment after the
        // request lands, and the gap would make the bar flicker away.
        syncing: localSyncInFlight || (status.syncing ?? false),
        progress: status.progress ?? null,
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

  async syncNow(workspacePath?: string | null, opts?: { allowBulkAdd?: boolean }) {
    if (!isTauri()) return
    const teamId = activeTeamId()
    if (!teamId) {
      set({ lastError: 'No active team to sync.' })
      return
    }
    localSyncInFlight = true
    set({ syncing: true, lastError: null })
    try {
      const result = await invoke<SyncNowResult>('oss_sync_now', {
        workspacePath: workspacePath ?? null,
        teamId,
        allowBulkAdd: opts?.allowBulkAdd ?? false,
      })
      set({
        pulled: result.pulled ?? 0,
        pushed: result.pushed ?? 0,
        conflicts: result.conflicts ?? 0,
        failed: result.failed ?? 0,
        oversize: result.oversize ?? [],
        blockedNewFiles: result.blockedNewFiles ?? null,
      })
      // Re-fetch status to get fresh lastSyncAt / mode from the daemon.
      await get().refresh(workspacePath)
    } catch (e) {
      set({ lastError: String(e) })
    } finally {
      localSyncInFlight = false
      set({ syncing: false, progress: null })
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
// then moved to `@/lib/daemon/jwt-bridge`. The daemon now self-supplies its FC JWT, so
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
