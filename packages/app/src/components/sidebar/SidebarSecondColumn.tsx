import { Suspense } from 'react'
import { useUIStore } from '@/stores/ui'
import { SessionListColumn } from './SessionListColumn'
import { useFeatures } from '@/lib/config/remote-features'
import { lazyNamed } from '@/lib/lazy-component'
import { PaneLoading } from '@/components/ui/pane-loading'

// The session list is the default column and stays in the startup chunk. The
// other columns are opened deliberately and each drags a sizeable subtree
// (team share alone is ~1,400 lines plus its detail components), so they load
// on first switch.
const ShortcutsListColumn = lazyNamed(() => import('./ShortcutsListColumn'), 'ShortcutsListColumn')
const TeamShareListColumn = lazyNamed(() => import('./TeamShareListColumn'), 'TeamShareListColumn')
const AppSessionsColumn = lazyNamed(() => import('./AppSessionsColumn'), 'AppSessionsColumn')
const ActorsView = lazyNamed(() => import('@/components/panel/ActorsView'), 'ActorsView')
const IdeasView = lazyNamed(() => import('@/components/panel/IdeasView'), 'IdeasView')

export function SidebarSecondColumn({ showNewSessionActions }: { showNewSessionActions?: boolean } = {}) {
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  const features = useFeatures()
  const column = resolveLazyColumn({ embedMode, filter, appsEnabled: features.apps })
  if (column) return <Suspense fallback={<PaneLoading />}>{column}</Suspense>
  return <SessionListColumn showNewSessionActions={showNewSessionActions} />
}

function resolveLazyColumn({
  embedMode,
  filter,
  appsEnabled,
}: {
  embedMode: boolean
  filter: ReturnType<typeof useUIStore.getState>['sidebarFilter']
  appsEnabled: boolean
}) {
  if (!embedMode && filter.kind === 'shortcuts') return <ShortcutsListColumn />
  if (!embedMode && filter.kind === 'ideas') return <IdeasView />
  // A filter persisted from a build that had Apps on must not render the column
  // in one that has it off. teamShare needs no such gate — it ships everywhere.
  if (filter.kind === 'apps' && appsEnabled) return <AppSessionsColumn />
  if (filter.kind === 'actors') return <ActorsView />
  if (filter.kind === 'teamShare') return <TeamShareListColumn section={filter.section} />
  return null
}
