import { useUIStore, type SidebarFilter } from '@/stores/ui'
import type { TeamShareSection } from '@/stores/team-share-browser'

/**
 * Nav sections that replace the conversation instead of sitting beside it.
 *
 * Picking one of these hides column three: column two lists the section's
 * items, and the item opens where the conversation was — the section's own
 * detail view, or (knowledge) column four's document tabs. Sessions, apps and
 * shortcuts are not sections in this sense: what they open belongs next to a
 * conversation.
 */
export type SectionMode = TeamShareSection | 'ideas' | 'actors'

export function sectionModeFor(filter: SidebarFilter): SectionMode | null {
  if (filter.kind === 'teamShare') return filter.section
  if (filter.kind === 'ideas') return 'ideas'
  if (filter.kind === 'actors') return 'actors'
  return null
}

export function useSectionMode(): SectionMode | null {
  return useUIStore((s) => sectionModeFor(s.sidebarFilter))
}
