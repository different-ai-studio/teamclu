import type { FileNode } from '@/stores/workspace'
import { teamSyncKeyForPath } from '@/lib/team-skill-paths'

/**
 * Directories inside a knowledge tree that exist for tooling, not for people.
 *
 * `.obsidian` is Obsidian's own per-vault config. We create it ourselves when
 * first registering the knowledge dir as a vault, so it is present on every
 * machine — and it is never synced, so listing it would put a folder nobody
 * asked for at the top of the team's documents.
 *
 * `.conflicts` holds the sync engine's local-only conflict copies (mirrored
 * under the note's relative path). Obsidian ignores dot-directories; we hide
 * the same folder so the tree badge on the document is the only signal.
 */
const KNOWLEDGE_TOOLING_DIRS = new Set(['.obsidian', '.conflicts'])

export interface KnowledgeScopeOpts {
  knowledgeDir?: string | null
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
    const inKnowledge = teamSyncKeyForPath(node.path, opts) !== null
    if (inKnowledge) {
      if (node.type === 'directory' && KNOWLEDGE_TOOLING_DIRS.has(node.name)) {
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
