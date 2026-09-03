import type { FileNode } from '@/stores/workspace'
import { teamSyncKeyForPath } from '@/lib/team/team-skill-paths'

/**
 * Directories inside a knowledge tree that exist for tooling, not for people.
 *
 * `.obsidian` is Obsidian's own per-vault config. We create it ourselves when
 * first registering the knowledge dir as a vault, so it is present on every
 * machine — and it is never synced, so listing it would put a folder nobody
 * asked for at the top of the team's documents. Matched by NAME at any depth,
 * which is what the daemon does too: `.obsidian/` in its builtin ignore list is
 * a gitignore pattern without a leading slash, so it matches at every level.
 */
const KNOWLEDGE_TOOLING_DIRS = new Set(['.obsidian'])

/**
 * The sync engine's local-only conflict copies, mirrored under the note's
 * relative path. Obsidian ignores dot-directories; we hide the same folder so
 * the tree badge on the document is the only signal.
 *
 * Matched by SYNC KEY, not by name: the daemon's `is_under_conflicts_dir` only
 * hard-skips `<prefix>/.conflicts`, so a folder a user happens to call
 * `.conflicts` deeper in the tree (`knowledge/projects/.conflicts/`) is theirs —
 * it syncs and is shared with the team. Hiding it by name would make files that
 * really do sync invisible: the same daemon/UI disagreement that once hid
 * `merge.conflict.md`, just inverted.
 */
const CONFLICTS_SYNC_KEY = 'knowledge/.conflicts'

interface KnowledgeScopeOpts {
  syncRoot?: string | null
  workspacePath?: string | null
}

/**
 * Drop what a team-knowledge tree should not show: tooling directories above.
 *
 * Conflict copies live under `.conflicts/` (not beside the note), so pruning
 * that directory is enough — do not hide ordinary notes whose names happen to
 * contain `.conflict.` (e.g. `merge.conflict.md`).
 *
 * Both rules are scoped to team knowledge by the same test, because a
 * workspace may legitimately hold the user's own Obsidian vault — hiding those
 * would be a bug of our own.
 *
 * Returns the SAME array when nothing was pruned, so the common case costs one
 * walk and no downstream re-render.
 */
export function pruneKnowledgeNoise(
  nodes: FileNode[],
  opts: KnowledgeScopeOpts,
): FileNode[] {
  let changed = false
  const out: FileNode[] = []
  for (const node of nodes) {
    const syncKey = teamSyncKeyForPath(node.path, opts)
    if (syncKey !== null && node.type === 'directory') {
      if (KNOWLEDGE_TOOLING_DIRS.has(node.name) || syncKey === CONFLICTS_SYNC_KEY) {
        changed = true
        continue
      }
    }
    if (node.children) {
      const children = pruneKnowledgeNoise(node.children, opts)
      if (children !== node.children) {
        changed = true
        out.push({ ...node, children })
        continue
      }
    }
    out.push(node)
  }
  return changed ? out : nodes
}
