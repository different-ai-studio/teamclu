import { useTabsStore } from '@/stores/tabs'
import {
  encodeKnowledgeConflictTarget,
  encodeCloudVersionTarget,
} from '@/lib/tabs/teamshare-target'

/**
 * Tab openers for the team-knowledge views.
 *
 * They live here rather than beside each view so the file tree and the sidebar
 * can reach them without importing the views themselves.
 */

/** Open the conflict-decision view for one document. */
export function openKnowledgeConflict(path: string, label: string) {
  useTabsStore.getState().openTab({
    type: 'native',
    target: encodeKnowledgeConflictTarget(path),
    label,
  })
}

/**
 * Open the read-only view of what the cloud currently holds for one document.
 *
 * Deliberately not a diff: the question this answers is "what do my teammates
 * see", which is the document itself, not the delta from what happens to be on
 * this disk.
 */
export function openCloudVersion(path: string, label: string) {
  useTabsStore.getState().openTab({
    type: 'native',
    target: encodeCloudVersionTarget(path),
    label,
  })
}
