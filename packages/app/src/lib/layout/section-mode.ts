import { useUIStore, type SidebarFilter } from '@/stores/ui'
import type { TeamShareSection } from '@/stores/team-share-browser'

/**
 * Nav sections that replace the conversation instead of sitting beside it.
 *
 * Picking one of these hides column three: column two lists the section's
 * items, and the item opens where the conversation was — the section's own
 * detail view, or (knowledge, shortcuts) column four's tabs. Sessions and apps
 * are not sections in this sense: what they open belongs next to a
 * conversation.
 */
export type SectionMode = TeamShareSection | 'ideas' | 'actors' | 'shortcuts'

/**
 * Sections whose items open as column-four tabs (documents, web pages) rather
 * than in a detail view of their own. There column four takes the place of
 * the conversation, so a file or page gets the whole content area.
 */
export function sectionOpensInContentColumn(section: SectionMode | null): boolean {
  return section === 'knowledge' || section === 'shortcuts'
}

export function sectionModeFor(filter: SidebarFilter): SectionMode | null {
  if (filter.kind === 'teamShare') return filter.section
  if (filter.kind === 'ideas') return 'ideas'
  if (filter.kind === 'actors') return 'actors'
  if (filter.kind === 'shortcuts') return 'shortcuts'
  return null
}

export function useSectionMode(): SectionMode | null {
  return useUIStore((s) => sectionModeFor(s.sidebarFilter))
}
