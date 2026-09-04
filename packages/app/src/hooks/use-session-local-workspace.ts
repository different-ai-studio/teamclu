import * as React from 'react'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { resolveSessionWorkspacePath } from '@/lib/session/session-by-workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionParticipantStore } from '@/stores/session-participant-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useWorkspaceStore } from '@/stores/workspace'

export type SessionLocalWorkspace = {
  /** The agent running on this machine is seated in the active session. */
  hasLocalAgent: boolean
  /** That agent's display name, for the file-tree footer. */
  agentName: string | null
  /**
   * The folder that agent works in for this session. Null until a runtime has
   * bound one — a session created a second ago has no binding yet.
   */
  path: string | null
}

const EMPTY: SessionLocalWorkspace = {
  hasLocalAgent: false,
  agentName: null,
  path: null,
}

/**
 * The workspace the file tree and terminal describe: the folder the **local**
 * agent works in for the session currently open.
 *
 * Both surfaces reach the filesystem of this machine, so a session with no
 * local agent has no folder to show — the caller hides them rather than
 * leaving the previous session's directory on screen, which is what used to
 * happen because the workspace store is ambient and only changes when a
 * session that resolves to a local path is opened.
 *
 * The path itself still comes from the workspace store. `switchToSession`
 * already drives that store from the session's own binding
 * (`switchToSessionWorkspaceIfNeeded`), so this hook reports where the tree is
 * rather than opening a second, competing source of truth for it — the store
 * has ~60 readers and they must not disagree with the tree.
 */
export function useSessionLocalWorkspace(): SessionLocalWorkspace {
  const sessionId = useSessionSelectionStore((s) => s.currentSessionId)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const participantsBySession = useSessionParticipantStore((s) => s.participantsBySession)
  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [boundPath, setBoundPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!sessionId) return
    void ensureParticipants([sessionId])
  }, [sessionId, ensureParticipants])

  // `switchToSessionWorkspaceIfNeeded` moves the workspace store in the
  // background, so the store alone cannot distinguish "this session's folder"
  // from "the folder left over from the last one". Resolve the binding to tell
  // them apart; re-run when the store lands on its answer.
  React.useEffect(() => {
    if (!sessionId || !teamId) {
      setBoundPath(null)
      return
    }
    let cancelled = false
    void resolveSessionWorkspacePath(teamId, sessionId)
      .then((path) => {
        if (!cancelled) setBoundPath(path?.trim() || null)
      })
      .catch(() => {
        if (!cancelled) setBoundPath(null)
      })
    return () => { cancelled = true }
  }, [sessionId, teamId, workspacePath])

  return React.useMemo(() => {
    if (!sessionId) return EMPTY
    const localAgentId = getKnownLocalDaemonActorId()
    if (!localAgentId) return EMPTY
    const participant = (participantsBySession[sessionId] ?? []).find(
      (p) => p.actorId === localAgentId,
    )
    if (!participant) return EMPTY
    return {
      hasLocalAgent: true,
      agentName: participant.displayName || null,
      path: boundPath,
    }
  }, [sessionId, participantsBySession, boundPath])
}
