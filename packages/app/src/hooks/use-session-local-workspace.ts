import * as React from 'react'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { resolveSessionWorkspacePath } from '@/lib/session/session-by-workspace'
import { workspacePathsMatch } from '@/stores/session-utils'
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
   * The folder that agent works in for this session, and only once the
   * workspace store has actually moved there. Null while a switch is in
   * flight, and for a session whose runtime has never bound a folder.
   */
  path: string | null
}

const EMPTY: SessionLocalWorkspace = {
  hasLocalAgent: false,
  agentName: null,
  path: null,
}

/**
 * One in-flight resolve per (team, session), shared by every hook instance.
 *
 * This hook runs in two places at once (the app header and the files pane) and
 * each resolve reaches `getSessionParticipants`, which the 5s viewer-context
 * cache does not cover. Without this, one session click issued four identical
 * Cloud round trips.
 */
const inFlight = new Map<string, Promise<string | null>>()

function resolveOnce(teamId: string, sessionId: string): Promise<string | null> {
  const key = `${teamId}:${sessionId}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = resolveSessionWorkspacePath(teamId, sessionId)
    .catch(() => null)
    .finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}

/**
 * The workspace the file tree and terminal describe: the folder the **local**
 * agent works in for the session currently open.
 *
 * Both surfaces reach the filesystem of this machine, so a session with no
 * local agent has no folder to show — the caller hides them rather than
 * leaving the previous session's directory on screen.
 *
 * `path` is deliberately gated on the workspace store agreeing. That store is
 * what `FileBrowser` renders from, and `switchToSessionWorkspaceIfNeeded` moves
 * it in the background (fire-and-forget, and it stays put if `setWorkspace`
 * throws). Reporting the binding before the store has followed would print one
 * folder's name over another folder's tree — a label that lies is worse than
 * the unlabelled tree this replaced.
 */
export function useSessionLocalWorkspace(): SessionLocalWorkspace {
  const sessionId = useSessionSelectionStore((s) => s.currentSessionId)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants)
  // Select this session's roster, not the whole map: every participant load in
  // the app replaces that object, and this hook is called from the app root.
  const participants = useSessionParticipantStore((s) =>
    sessionId ? s.participantsBySession[sessionId] : undefined,
  )
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  // The local actor id arrives from the daemon's `/v1/info` and is cached in a
  // module + localStorage. A bare read inside a memo can never observe it
  // landing (nothing in the dep list changes), which on a fresh install left
  // the tree and terminal hidden with no way back.
  const [localAgentId, setLocalAgentId] = React.useState<string | null>(() =>
    getKnownLocalDaemonActorId(),
  )
  React.useEffect(() => {
    if (localAgentId) return
    let cancelled = false
    void (async () => {
      try {
        const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
        const id = await getLocalDaemonActorId()
        if (!cancelled && id?.trim()) setLocalAgentId(id.trim())
      } catch {
        /* offline — the sidebar's own probe will note it later */
      }
    })()
    return () => { cancelled = true }
  }, [localAgentId, sessionId])

  // Keyed by session so an in-flight resolve for the session we just left can
  // never be read as this one's answer.
  const [bound, setBound] = React.useState<{ sessionId: string; path: string | null } | null>(null)

  React.useEffect(() => {
    if (!sessionId) return
    void ensureParticipants([sessionId])
  }, [sessionId, ensureParticipants])

  React.useEffect(() => {
    if (!sessionId || !teamId) {
      setBound(null)
      return
    }
    let cancelled = false
    void resolveOnce(teamId, sessionId).then((path) => {
      if (!cancelled) setBound({ sessionId, path: path?.trim() || null })
    })
    return () => { cancelled = true }
  }, [sessionId, teamId])

  return React.useMemo(() => {
    if (!sessionId || !localAgentId) return EMPTY
    const participant = (participants ?? []).find((p) => p.actorId === localAgentId)
    if (!participant) return EMPTY

    const boundPath = bound?.sessionId === sessionId ? bound.path : null
    const settled =
      !!boundPath && !!workspacePath && workspacePathsMatch(boundPath, workspacePath)

    return {
      hasLocalAgent: true,
      agentName: participant.displayName || null,
      path: settled ? boundPath : null,
    }
  }, [sessionId, localAgentId, participants, bound, workspacePath])
}
