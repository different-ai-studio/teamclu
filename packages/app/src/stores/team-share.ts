import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { getEffectiveServerConfigSync } from '@/lib/server-config'

// ---------------------------------------------------------------------------
// Types — mirror FC GET /v1/teams/:id/share-mode response (camelCase JSON)
// ---------------------------------------------------------------------------

export type ShareMode = 'oss' | null

export type LockedShareMode = Exclude<ShareMode, null>

export function isShareModeLocked(
  mode: ShareMode | undefined | null,
): mode is LockedShareMode {
  return mode === 'oss'
}

/** Match the daemon: an unrecognized/unset FC mode means "not enabled". */
export function normalizeShareStatus(raw: Partial<ShareStatus>): ShareStatus {
  const mode = (raw?.mode ?? null) as ShareMode
  if (!isShareModeLocked(mode)) {
    return {
      mode: null,
      enabledAt: null,
      linkStatus: raw?.linkStatus,
      globalPath: raw?.globalPath ?? null,
    }
  }
  return {
    mode,
    enabledAt: raw?.enabledAt ?? null,
    linkStatus: raw?.linkStatus,
    globalPath: raw?.globalPath ?? null,
  }
}

// What the workspace `teamclu-team` entry currently is, as reported by the
// daemon-aware `team_share_get_status` command.
export type LinkStatus = 'symlink' | 'real_dir' | 'missing'

export interface ShareStatus {
  mode: ShareMode
  enabledAt?: string | null
  // Per-workspace link to the daemon's single global copy, and where that
  // global copy lives on disk (~/.amuxd/teams/<team_id>/teamclu-team).
  // Absent when the status was read without a workspace — there is no single
  // workspace whose link it could describe.
  linkStatus?: LinkStatus
  globalPath?: string | null
}

// Result of an enable_* command (matches Rust `EnableShareResult`).
export interface EnableShareResult {
  teamId: string
  shareMode: string
  cloneWarning?: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TeamShareState {
  status: ShareStatus
  loading: boolean
  lastError: string | null

  /**
   * Read the team's share mode. `workspacePath` is optional and only decorates
   * the result with that workspace's `linkStatus` — the mode is the team's, and
   * comes from the Cloud API.
   */
  refresh(teamId: string, workspacePath?: string | null): Promise<ShareStatus>
  /**
   * Save the team secret and deliver it to the daemon. Resolves to a warning
   * string when the save succeeded but the daemon did not take delivery — the
   * daemon's copy is what decrypts shared env vars, so until it lands they
   * stay dead. `null` on full success.
   */
  setSecret(
    teamId: string,
    secretHex: string,
    workspacePath: string,
  ): Promise<string | null>
  /** Read back the locally-stored team secret; `null` when none is saved. */
  getSecret(teamId: string, workspacePath: string): Promise<string | null>
}

const EMPTY_STATUS: ShareStatus = {
  mode: null,
  enabledAt: null,
}

function getCloudApiUrlForNativeCommand(): string {
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl
  if (!cloudApiUrl) throw new Error('Cloud API URL is not configured')
  return cloudApiUrl
}

/** Coalesce concurrent refresh calls for the same team + workspace. */
let shareRefreshInflight: Promise<ShareStatus> | null = null
let shareRefreshInflightKey: string | null = null

export const useTeamShareStore = create<TeamShareState>((set) => ({
  status: EMPTY_STATUS,
  loading: false,
  lastError: null,

  async refresh(teamId, workspacePath) {
    if (!isTauri()) return { ...EMPTY_STATUS }

    const key = `${teamId}\0${workspacePath ?? ''}`
    if (shareRefreshInflight && shareRefreshInflightKey === key) {
      return shareRefreshInflight
    }

    shareRefreshInflightKey = key
    shareRefreshInflight = (async () => {
      // Keep the previous status visible while loading — clearing to EMPTY here
      // made TeamSection flip between surfaces and spam daemon APIs.
      set({ loading: true, lastError: null })
      try {
        const accessToken = await getFreshAccessToken()
        const cloudApiUrl = getCloudApiUrlForNativeCommand()
        const raw = await invoke<ShareStatus>('team_share_get_status', {
          teamId,
          workspacePath: workspacePath ?? null,
          accessToken,
          cloudApiUrl,
        })
        const next = normalizeShareStatus({
          mode: (raw?.mode ?? null) as ShareMode,
          enabledAt: raw?.enabledAt ?? null,
          linkStatus: raw?.linkStatus,
          globalPath: raw?.globalPath ?? null,
        })
        set({ status: next })
        return next
      } catch (e) {
        set({ lastError: String(e), status: { ...EMPTY_STATUS } })
        return { ...EMPTY_STATUS }
      } finally {
        set({ loading: false })
        shareRefreshInflight = null
        shareRefreshInflightKey = null
      }
    })()

    return shareRefreshInflight
  },

  async setSecret(teamId, secretHex, workspacePath) {
    const warning = await invoke<string | null>('team_share_set_team_secret', {
      teamId,
      secretHex,
      workspacePath,
    })
    return warning ?? null
  },

  async getSecret(teamId, workspacePath) {
    if (!isTauri()) return null
    // Deliberately unguarded. Rust distinguishes "no secret configured"
    // (returns null) from "the store is there but unreadable" (throws), and a
    // catch-all here collapsed both to null — telling the user to configure a
    // key they already have, and hiding the real cause: a corrupt blob or wrong
    // master key, which needs quarantine, not retyping. Callers handle the
    // throw (see TeamSecretEntry).
    const secret = await invoke<string | null>('team_share_get_team_secret', {
      teamId,
      workspacePath,
    })
    return secret ?? null
  },

}))
