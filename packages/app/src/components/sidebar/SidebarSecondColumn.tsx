import { useUIStore } from '@/stores/ui'
import { ActorsView, IdeasView } from '@/components/panel'
import { SessionListColumn } from './SessionListColumn'
import { ShortcutsListColumn } from './ShortcutsListColumn'
import { TeamShareListColumn } from './TeamShareListColumn'
import { AppSessionsColumn } from './AppSessionsColumn'
import { useFeatures } from '@/lib/remote-features'

export function SidebarSecondColumn({ showNewSessionActions }: { showNewSessionActions?: boolean } = {}) {
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  const features = useFeatures()
  if (!embedMode && filter.kind === 'shortcuts') return <ShortcutsListColumn />
  if (!embedMode && filter.kind === 'ideas') return <IdeasView />
  // A filter persisted from a build that had Apps on must not render the column
  // in one that has it off. teamShare needs no such gate — it ships everywhere.
  if (filter.kind === 'apps' && features.apps) return <AppSessionsColumn />
  if (filter.kind === 'actors') return <ActorsView />
  if (filter.kind === 'teamShare') return <TeamShareListColumn section={filter.section} />
  return <SessionListColumn showNewSessionActions={showNewSessionActions} />
}
