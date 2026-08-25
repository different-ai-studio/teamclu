import { useTabsStore } from '@/stores/tabs'
import { encodeKnowledgeConflictTarget } from '@/lib/tabs/teamshare-target'

/**
 * Open the conflict-decision view for one document.
 *
 * Lives here rather than beside the view so the file tree and the sidebar can
 * both reach it without importing the whole resolver.
 */
export function openKnowledgeConflict(path: string, label: string) {
  useTabsStore.getState().openTab({
    type: 'native',
    target: encodeKnowledgeConflictTarget(path),
    label,
  })
}
