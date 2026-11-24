import { useUIStore, type SidebarFilter } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { resolveAppLocality } from '@/lib/apps/app-locality'
import type { TeamShareSection } from '@/stores/team-share-browser'

/**
 * Nav sections that replace the conversation instead of sitting beside it.
 *
 * Picking one of these hides column three: column two lists the section's
 * items, and the item opens where the conversation was — the section's own
 * detail view, or (knowledge, shortcuts) column four's tabs. Sessions are not
 * sections in this sense: what they open belongs next to a conversation.
 *
 * Apps are both. While column two lists the apps, the main view is every app
 * the team has — the library, as the marketplace is for skills. Once an app is
 * drilled into, its sessions open next to the conversation like any others.
 */
export type SectionMode = TeamShareSection | 'ideas' | 'actors' | 'shortcuts' | 'apps'

/**
 * Sections whose items open as column-four tabs (documents, web pages) rather
 * than in a detail view of their own. There column four takes the place of
 * the conversation, so a file or page gets the whole content area.
 */
export function sectionOpensInContentColumn(section: SectionMode | null): boolean {
  return section === 'knowledge' || section === 'shortcuts'
}

/**
 * `appsListShown`: column two is on its app list rather than one app's
 * sessions — what `AppsColumn` decides.
 */
export function sectionModeFor(filter: SidebarFilter, appsListShown = true): SectionMode | null {
  if (filter.kind === 'apps') return appsListShown ? 'apps' : null
  if (filter.kind === 'teamShare') return filter.section
  if (filter.kind === 'ideas') return 'ideas'
  if (filter.kind === 'actors') return 'actors'
  if (filter.kind === 'shortcuts') return 'shortcuts'
  return null
}

/**
 * `AppsColumn`'s rule for showing the app list instead of an app's sessions:
 * no app selected, a selection that resolves to nothing, or an app whose
 * checkout is not on this machine.
 */
function useAppsListShown(): boolean {
  return useAppsStore((s) => {
    if (!s.selectedAppId) return true
    if (!s.items.some((a) => a.id === s.selectedAppId)) return true
    return resolveAppLocality(s.localAppIds, s.selectedAppId) === false
  })
}

export function useSectionMode(): SectionMode | null {
  const appsListShown = useAppsListShown()
  return useUIStore((s) => sectionModeFor(s.sidebarFilter, appsListShown))
}
