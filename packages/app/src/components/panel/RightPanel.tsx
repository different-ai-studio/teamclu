import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { SessionActorPanel } from '@/components/chat/SessionActorSheet'
import { ShortcutsPanel } from './ShortcutsPanel'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { ActorsView } from '@/components/panel/ActorsView'
import { SessionWorkspacePicker } from '@/components/panel/SessionWorkspacePicker'
import { useWorkspaceStore, type RightPanelTab } from '@/stores/workspace'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionLocalWorkspace } from '@/hooks/use-session-local-workspace'
import { shortenWorkspacePath } from '@/lib/workspace/shorten-path'

interface RightPanelProps {
  // Override the active tab from store
  defaultTab?: RightPanelTab
  // Compact mode for file mode layout
  compact?: boolean
}

/**
 * The file tree, plus the fixed line naming whose folder it is.
 *
 * The tab only opens for a session the local agent is in (App gates the header
 * entry on the same hook). Empty states:
 * - binding resolved with no folder, seat confirmed empty → the pane offers
 *   the local agent's workspaces (or a folder to browse to) to bind
 * - binding resolved with no folder, seat not confirmed empty → say the folder
 *   could not be read; a picker there could overwrite a bound seat
 * - binding resolved to a folder the window has not moved to → name that
 *   folder and offer the (guarded) switch. Mid-switch this is a beat; when the
 *   switch was skipped it is where the pane stays, and "Agent 尚未启动" there
 *   blamed an agent that was fine
 * - otherwise binding still resolving → waiting on runtime
 * Rendering the previous session's tree in that gap is the bug this replaces.
 */
function WorkspaceFilesPane() {
  const { t } = useTranslation()
  const { agentId, agentName, path, bindingResolved, boundPath, needsWorkspace } =
    useSessionLocalWorkspace()
  const sessionId = useSessionSelectionStore(s => s.currentSessionId)
  const teamId = useCurrentTeamStore(s => s.team?.id ?? null)
  const [switching, setSwitching] = React.useState(false)

  // The same guarded switch a session click runs: it only adopts a folder that
  // exists on this machine, so the button cannot persist another machine's path.
  const switchToBound = React.useCallback(async () => {
    if (!teamId || !sessionId) return
    setSwitching(true)
    try {
      const { switchToSessionWorkspaceIfNeeded } = await import('@/lib/session/session-by-workspace')
      await switchToSessionWorkspaceIfNeeded(teamId, sessionId)
    } catch (e) {
      console.warn('[RightPanel] could not switch to the session workspace', e)
    } finally {
      setSwitching(false)
    }
  }, [teamId, sessionId])

  if (!path) {
    if (bindingResolved && boundPath) {
      return (
        <div
          data-testid="files-workspace-not-switched"
          className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center"
        >
          <div className="text-[12.5px] text-muted-foreground">
            {t('fileExplorer.workspaceNotSwitched', '还没切换到该会话的工作目录')}
          </div>
          <div className="max-w-full truncate text-[12px] text-faint" title={boundPath}>
            {shortenWorkspacePath(boundPath)}
          </div>
          <button
            type="button"
            data-testid="files-workspace-switch"
            disabled={switching || !teamId || !sessionId}
            onClick={() => { void switchToBound() }}
            className="mt-1 rounded-md px-2.5 py-1 text-[12px] text-ink-2 ring-1 ring-border hover:bg-black/[0.04] disabled:opacity-50"
          >
            {t('fileExplorer.switchToWorkspace', '切换过去')}
          </button>
        </div>
      )
    }
    if (bindingResolved && !boundPath && !needsWorkspace) {
      return (
        <div
          data-testid="files-workspace-unavailable"
          className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-muted-foreground"
        >
          {t('fileExplorer.workspaceUnavailable', '读取不到该会话的工作目录')}
        </div>
      )
    }
    if (bindingResolved && !boundPath) {
      return (
        <div
          data-testid="files-no-workspace"
          className="flex h-full flex-col items-center justify-center overflow-y-auto px-4 py-6 text-center"
        >
          <div className="text-[12.5px] text-muted-foreground">
            {t('fileExplorer.noWorkspaceBound', '该会话没有工作目录')}
          </div>
          {agentId ? (
            <>
              <div className="mt-1 text-[12px] text-faint">
                {agentName
                  ? t('fileExplorer.pickWorkspaceHint', '为 {{agent}} 选择一个工作目录', { agent: agentName })
                  : t('fileExplorer.pickWorkspaceHintNoName', '为本机 Agent 选择一个工作目录')}
              </div>
              <SessionWorkspacePicker agentId={agentId} />
            </>
          ) : null}
        </div>
      )
    }
    return (
      <div
        data-testid="files-agent-not-started"
        className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-muted-foreground"
      >
        {t('fileExplorer.agentNotStarted', 'Agent 尚未启动')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <FileBrowser variant="panel" />
      </div>
      <div
        data-testid="files-workspace-footer"
        className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground"
        title={path}
      >
        {agentName ? (
          <span className="shrink-0 font-medium text-ink-2">{agentName}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-faint">
          {shortenWorkspacePath(path)}
        </span>
      </div>
    </div>
  )
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
        <WorkspaceFilesPane />
      )}
      {activeTab === 'actors' && (
        activeSessionId
          ? <SessionActorPanel sessionId={activeSessionId} teamId={teamIdForActors} />
          : <ActorsView />
      )}
    </div>
  )
}
