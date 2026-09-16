import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { listDaemonWorkspaces, type DaemonWorkspace } from '@/lib/daemon/daemon-workspaces'
import {
  bindSessionAgentWorkspace,
  ensureAgentWorkspaceForPath,
} from '@/lib/session/session-agent-workspace'
import { shortenWorkspacePath } from '@/lib/workspace/shorten-path'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { workspacePathsMatch } from '@/stores/session-utils'
import { useWorkspaceStore } from '@/stores/workspace'

/** `bindingKey` while the directory dialog, rather than a listed row, is being bound. */
const BROWSE = 'browse'

type SeatableWorkspace = DaemonWorkspace & { path: string }

interface SessionWorkspacePickerProps {
  /** This machine's agent, seated in the open session with no folder. */
  agentId: string
}

/**
 * The way out of "该会话没有工作目录": pick one of this machine's agent's
 * workspaces, or browse to a folder and register it on the spot. Either one
 * becomes the agent's seat in the open session.
 */
export function SessionWorkspacePicker({ agentId }: SessionWorkspacePickerProps) {
  const { t } = useTranslation()
  const sessionId = useSessionSelectionStore((s) => s.currentSessionId)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const memberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const windowPath = useWorkspaceStore((s) => s.workspacePath)

  // Null while loading.
  const [workspaces, setWorkspaces] = React.useState<SeatableWorkspace[] | null>(null)
  const [bindingKey, setBindingKey] = React.useState<string | null>(null)
  // The guard. `bindingKey` only disables the rows once React has re-rendered,
  // and a double click lands both clicks before that.
  const bindingRef = React.useRef(false)

  React.useEffect(() => {
    if (!teamId) return
    let cancelled = false
    setWorkspaces(null)
    listDaemonWorkspaces(teamId, agentId)
      .then((rows) => {
        if (cancelled) return
        setWorkspaces(
          rows
            .filter((w): w is SeatableWorkspace => !w.archived && !!w.path)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        )
      })
      .catch((e) => {
        console.warn('[SessionWorkspacePicker] workspace load failed (non-fatal):', e)
        if (!cancelled) setWorkspaces([])
      })
    return () => {
      cancelled = true
    }
  }, [teamId, agentId])

  const bind = async (
    key: string,
    pick: () => Promise<{ id: string; path: string } | null>,
  ) => {
    if (!sessionId || !teamId || bindingRef.current) return
    bindingRef.current = true
    setBindingKey(key)
    try {
      const workspace = await pick()
      if (!workspace) return
      await bindSessionAgentWorkspace({
        teamId,
        sessionId,
        agentId,
        viewerMemberId: memberId,
        workspace,
      })
    } catch (e) {
      console.warn('[SessionWorkspacePicker] binding failed:', e)
      toast.error(
        t('fileExplorer.bindWorkspaceFailed', '设置工作目录失败：{{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      bindingRef.current = false
      setBindingKey(null)
    }
  }

  const browse = () =>
    bind(BROWSE, async () => {
      if (!teamId) return null
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('fileExplorer.browseWorkspaceTitle', '选择工作目录'),
      })
      const path = typeof selected === 'string' ? selected.trim() : ''
      if (!path) return null
      return ensureAgentWorkspaceForPath({ teamId, agentId, memberId, path })
    })

  return (
    <div className="mt-4 w-full max-w-[320px] text-left">
      {workspaces === null ? (
        <div className="flex items-center justify-center gap-2 py-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('fileExplorer.workspacesLoading', '加载中…')}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="py-1 text-center text-[12px] text-faint">
          {t('fileExplorer.noLocalWorkspaces', '本机还没有工作目录')}
        </div>
      ) : (
        <ul
          data-testid="files-workspace-options"
          className="max-h-[50vh] overflow-y-auto rounded-[10px] border border-border bg-paper"
        >
          {workspaces.map((w) => {
            const isWindow = !!windowPath && workspacePathsMatch(w.path, windowPath)
            return (
              <li key={w.id} className="border-b border-border-soft last:border-b-0">
                <button
                  type="button"
                  disabled={!!bindingKey}
                  onClick={() => void bind(w.id, async () => ({ id: w.id, path: w.path }))}
                  title={w.path}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-selected disabled:cursor-default disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-ink-2">{w.name}</span>
                      {isWindow ? (
                        <span className="shrink-0 text-[11px] text-faint">
                          {t('fileExplorer.workspaceCurrentWindowTag', '当前窗口')}
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-[11px] text-faint">
                      {shortenWorkspacePath(w.path)}
                    </span>
                  </span>
                  {bindingKey === w.id ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-full gap-1.5 text-[12.5px] shadow-none"
        disabled={!!bindingKey || !sessionId || !teamId}
        onClick={() => void browse()}
      >
        {bindingKey === BROWSE ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5" />
        )}
        {t('fileExplorer.browseWorkspace', '浏览其他目录…')}
      </Button>
    </div>
  )
}
