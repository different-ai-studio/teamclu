import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useOssSyncStore } from '@/stores/oss-sync'
import { globalTeamSyncShareRoot } from '@/lib/team-skill-paths'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'

/**
 * One conflict waiting for a human decision.
 *
 * A conflict happens when a document changed on both sides: the sync engine
 * parks the local bytes in a sidecar under `.conflicts/` and lets the remote
 * version overwrite the document. So `path` is the document the user recognises
 * (already holding the REMOTE text), and `sidecar` is where their own text went
 * (e.g. `knowledge/.conflicts/a/foo.conflict.<ts>.<hash>.md`).
 */
/** The two fixed roots a sync key may name. */
const SYNC_ROOTS = ['knowledge/', 'documents/'] as const

export interface TeamConflict {
  /** Sync key of the document, e.g. `knowledge/onboarding.md`. */
  path: string
  /** Sync key of the sidecar holding the local copy that lost. */
  sidecar: string
  /** Unix seconds recorded in the sidecar name; null when unparseable. */
  conflictedAt: number | null
  kind: string
}

/** What to do with one conflict. */
export type ConflictChoice = 'keepLocal' | 'keepRemote'

interface TeamConflictsState {
  entries: TeamConflict[]
  /** Conflicts grouped by document sync key, newest first within a document. */
  bySyncKey: Record<string, TeamConflict[]>
  /** `~/.amuxd[-brand]/teams/<id>/shared/knowledge`, for path mapping. */
  syncRoot: string | null
  loading: boolean
  error: string | null

  load(): Promise<void>
  /**
   * Carry out one decision, then reload. `keepLocal` also kicks a sync: the
   * restored copy is only on this disk until a push carries it up, and waiting
   * out the daemon's 5-minute timer would read as "my choice did nothing".
   */
  resolve(entry: TeamConflict, choice: ConflictChoice): Promise<void>
  /** Absolute path of a sync key under this device's knowledge dir. */
  absPathFor(syncKey: string): string | null
  reset(): void
}


function groupBySyncKey(entries: TeamConflict[]): Record<string, TeamConflict[]> {
  const out: Record<string, TeamConflict[]> = {}
  for (const entry of entries) {
    ;(out[entry.path] ??= []).push(entry)
  }
  return out
}

export const useTeamConflictsStore = create<TeamConflictsState>((set, get) => ({
  entries: [],
  bySyncKey: {},
  syncRoot: null,
  loading: false,
  error: null,

  async load() {
    if (!isTauri()) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) {
      set({ entries: [], bySyncKey: {}, error: null })
      return
    }
    set({ loading: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const [entries, syncRoot] = await Promise.all([
        invoke<TeamConflict[]>('team_conflicts', { teamId }),
        // Resolved alongside the list rather than once at startup: switching
        // teams repoints it, and a stale dir maps every conflict to a file that
        // is not there.
        globalTeamSyncShareRoot().catch(() => null),
      ])
      const list = entries ?? []
      set({
        entries: list,
        bySyncKey: groupBySyncKey(list),
        syncRoot,
        loading: false,
        error: null,
      })
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },

  async resolve(entry, choice) {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) throw new Error('No active team')
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('team_resolve_conflict', {
      teamId,
      path: entry.path,
      sidecar: entry.sidecar,
      choice,
    })
    await get().load()
    if (choice === 'keepLocal') {
      await useOssSyncStore.getState().syncNow()
      window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
    }
  },

  absPathFor(syncKey) {
    // A sync key already begins with its root name (`knowledge/…`,
    // `documents/…`), and the sync root is their shared parent — so the key
    // appends directly, with nothing to strip. Both roots resolve here; a
    // conflict in either is a file the user has to be able to open.
    //
    // A key naming anything else is not ours to place. Retired prefixes still
    // appear in old data (`skills/`, `.mcp/`), and turning one into a path
    // would point the UI at a file that does not exist.
    const dir = get().syncRoot
    if (!dir || !SYNC_ROOTS.some((root) => syncKey.startsWith(root))) return null
    return `${dir.replace(/[/\\]+$/, '')}/${syncKey}`
  },

  reset() {
    set({ entries: [], bySyncKey: {}, loading: false, error: null })
  },
}))
