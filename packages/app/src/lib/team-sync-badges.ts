import type { LocalChangeStatus } from '@/stores/team-sync-status'

/**
 * What a row in the knowledge tree says about itself.
 *
 * `both` is the one that earns its place: it is the only state that warns
 * BEFORE the damage, since two sides editing the same document is exactly what
 * produces a conflict on the next sync. The others are after-the-fact reports.
 */
export type SyncBadge =
  | 'conflict'
  | 'both'
  | 'local-new'
  | 'local-modified'
  | 'remote-ahead'

/**
 * Which badge wins when a folder contains several. Higher is louder: a folder
 * holding one conflict and nine tidy edits should read as "there is a conflict
 * in here".
 */
const RANK: Record<SyncBadge, number> = {
  'conflict': 4,
  'both': 3,
  'local-modified': 2,
  'local-new': 2,
  'remote-ahead': 1,
}

export interface BadgeInputs {
  /** Sync keys with a conflict sidecar on disk. */
  conflicts: Record<string, unknown>
  /** Sync key → local change (from the daemon's live tree scan). */
  local: Record<string, LocalChangeStatus>
  /** Sync key → a version waiting in the cloud. */
  remote: Record<string, unknown>
}

/**
 * Fold the three sources into one badge per document.
 *
 * A DELETED file gets an entry too, even though its own row is gone from the
 * tree — that entry is what its folder inherits. Without it, deleting a synced
 * document left the panel counting a pending push (`↑1`) that nothing anywhere
 * in the tree accounted for.
 */
export function buildBadgeMap({ conflicts, local, remote }: BadgeInputs): Record<string, SyncBadge> {
  const out: Record<string, SyncBadge> = {}

  for (const key of Object.keys(conflicts)) out[key] = 'conflict'

  for (const [key, status] of Object.entries(local)) {
    if (out[key] === 'conflict') continue
    if (key in remote) {
      out[key] = 'both'
    } else if (status === 'new') {
      out[key] = 'local-new'
    } else {
      // Edited or deleted: both are "changed here, not pushed", which is what
      // the folder should say. A deletion has no row of its own to contradict.
      out[key] = 'local-modified'
    }
  }

  for (const key of Object.keys(remote)) {
    if (out[key]) continue
    out[key] = 'remote-ahead'
  }

  return out
}

/**
 * The badge a folder inherits from what is inside it, or `null` when nothing in
 * there has anything to say.
 */
export function badgeForDirectory(
  dirKey: string,
  badges: Record<string, SyncBadge>,
): SyncBadge | null {
  const prefix = `${dirKey}/`
  let winner: SyncBadge | null = null
  for (const [key, badge] of Object.entries(badges)) {
    if (!key.startsWith(prefix)) continue
    if (!winner || RANK[badge] > RANK[winner]) winner = badge
  }
  return winner
}
