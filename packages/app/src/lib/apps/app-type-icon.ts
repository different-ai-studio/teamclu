import { Database, FolderGit2, Globe, Presentation, type LucideIcon } from 'lucide-react'
import { resolveAppType, type AppTypeId } from '@/lib/apps/app-types'

/**
 * One glyph per app type, so a list of apps is scannable by kind.
 *
 * Every row used to carry the same `AppWindow`, which made the icon column pure
 * decoration — eleven identical marks down the left edge. The type is already
 * spelled out in the row's meta line; the glyph is what makes it readable
 * without reading.
 */
const ICONS: Record<AppTypeId, LucideIcon> = {
  static_web: Globe,
  slides: Presentation,
  data_app: Database,
  // Not a kind of app so much as a kind of origin: its code came from a repo
  // someone already had.
  imported: FolderGit2,
}

/** Takes the raw stored `apps.type`, which is not always a known id. */
export function appTypeIcon(raw: string | null | undefined): LucideIcon {
  return ICONS[resolveAppType(raw).id]
}
