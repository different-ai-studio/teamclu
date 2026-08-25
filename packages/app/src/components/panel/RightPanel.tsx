import { SessionDiffPanel } from '@/components/chat/SessionDiffPanel'
import { SessionList } from '@/components/chat/SessionList'
import { SessionActorPanel } from '@/components/chat/SessionActorSheet'
import { ShortcutsPanel } from './ShortcutsPanel'
import { ActorsView } from '@/components/panel/ActorsView'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSessionStore } from '@/stores/session'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { FileDiff } from '@/stores/session-types'

interface RightPanelProps {
  diff?: FileDiff[]
  // Override the active tab from store
  defaultTab?: 'diff' | 'session' | 'shortcuts' | 'actors'
  // Compact mode for file mode layout
  compact?: boolean
}

export function RightPanel({ diff, defaultTab, compact }: RightPanelProps) {
  const storeActiveTab = useWorkspaceStore(s => s.activeTab)
  const sessionDiff = useSessionStore(s => s.sessionDiff)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessionRow = useSessionListStore(s => s.rows.find(r => r.id === activeSessionId))
  const currentTeamId = useCurrentTeamStore(s => s.team?.id ?? null)
  const teamIdForActors = sessionRow?.team_id ?? currentTeamId

  // Use defaultTab if provided, otherwise use store's activeTab
  const activeTab = defaultTab || storeActiveTab
  const diffData = diff ?? sessionDiff

  const noPadding = activeTab === 'session' || activeTab === 'actors'

  return (
    <div
      className={`h-full min-h-0 overflow-auto ${noPadding ? '' : (compact ? 'p-1' : 'p-2')}`}
    >
      {activeTab === 'shortcuts' && (
        <ShortcutsPanel />
      )}
      {activeTab === 'diff' && (
        <DiffTab diff={diffData} compact={compact} />
      )}
      {activeTab === 'session' && (
        <SessionList compact={compact} />
      )}
      {activeTab === 'actors' && (
        activeSessionId
          ? <SessionActorPanel sessionId={activeSessionId} teamId={teamIdForActors} />
          : <ActorsView />
      )}
    </div>
  )
}

// Diff tab content
function DiffTab({ diff, compact }: { diff: FileDiff[], compact?: boolean }) {
  if (diff.length === 0) {
    return (
      <div className={`text-muted-foreground text-center ${compact ? 'text-xs py-3' : 'text-xs py-4'}`}>
        No changes yet
      </div>
    )
  }

  return <SessionDiffPanel diff={diff} compact={compact} />
}
