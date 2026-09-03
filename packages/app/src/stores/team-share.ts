import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Store
//
// What used to live here — `ShareMode`, `ShareStatus`, `normalizeShareStatus`,
// `isShareModeLocked` and the `refresh()` that read
// `GET /v1/teams/:id/share-mode` — is gone.
//
// That flag was a switch with no producer: nothing in the product ships a call
// to `POST /v1/teams/:id/share-mode`, so every team created since reads as
// "off". Everything that branched on it therefore did nothing, silently, for
// every one of those teams: the cloud-sync button returned before doing any
// work, the sync-status poll never ran, and the daemon's link sweep actively
// removed the team links it exists to create.
//
// Whether a team can sync is decided where the sync runs, by the thing that
// actually decides it: the team secret (`sync::dispatch::run_once`). That is
// what these two calls manage.
// ---------------------------------------------------------------------------

interface TeamShareState {
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

export const useTeamShareStore = create<TeamShareState>(() => ({
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
