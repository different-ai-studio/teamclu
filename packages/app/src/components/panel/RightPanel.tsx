import { SessionActorPanel } from '@/components/chat/SessionActorSheet'
import { ShortcutsPanel } from './ShortcutsPanel'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { ActorsView } from '@/components/panel/ActorsView'
import { useWorkspaceStore, type RightPanelTab } from '@/stores/workspace'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'

interface RightPanelProps {
  // Override the active tab from store
  defaultTab?: RightPanelTab
  // Compact mode for file mode layout
  compact?: boolean
}

export function RightPanel({ defaultTab, compact }: RightPanelProps) {
  const storeActiveTab = useWorkspaceStore(s => s.activeTab)
  const activeSessionId = useSessionSelectionStore(s => s.activeSessionId)
  const sessionRow = useSessionListStore(s => s.rows.find(r => r.id === activeSessionId))
  const currentTeamId = useCurrentTeamStore(s => s.team?.id ?? null)
  const teamIdForActors = sessionRow?.team_id ?? currentTeamId

  // Use defaultTab if provided, otherwise use store's activeTab
  const activeTab = defaultTab || storeActiveTab

  // `files` renders a self-contained FileBrowser that owns its own scroll
  // area and keeps a fixed toolbar. That pane must NOT sit inside an outer
  // `overflow-auto` scroller — otherwise the toolbar header scrolls away with
  // the tree. Give it a bounded flex column so the inner scroll area (and thus
  // the pinned toolbar) works.
  const selfScrolling = activeTab === 'files'
  const noPadding = activeTab === 'actors'

  return (
    <div
      className={`h-full min-h-0 ${selfScrolling ? 'overflow-hidden flex flex-col' : 'overflow-auto'} ${noPadding ? '' : (compact ? 'p-1' : 'p-2')}`}
    >
      {activeTab === 'shortcuts' && (
        <ShortcutsPanel />
      )}
      {activeTab === 'files' && (
        <FileBrowser variant="panel" />
      )}
      {activeTab === 'actors' && (
        activeSessionId
          ? <SessionActorPanel sessionId={activeSessionId} teamId={teamIdForActors} />
          : <ActorsView />
      )}
    </div>
  )
}
