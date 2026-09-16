/**
 * Give this machine's agent a folder in a session it is already seated in.
 *
 * An agent pulled into an existing session is seated with no workspace:
 * `POST …/participants` never names one, and only session creation stamps the
 * seat. The file tree, runtime-start and the daemon all read the agent's folder
 * from that seat (ADR-0005), so the files pane had nothing to show and the agent
 * ran wherever the fallbacks put it. This is how the pane binds one.
 */
import { getBackend } from '@/lib/backend'
import { upsertSessionWorkspacesBatch } from '@/lib/cache/local-cache'
import {
  createDaemonWorkspace,
  listDaemonWorkspaces,
  type DaemonWorkspace,
} from '@/lib/daemon/daemon-workspaces'
import { invalidateViewerWorkspaceContext } from '@/lib/session/session-viewer-workspace'
import { noteSessionWorkspaceRebound } from '@/lib/session/session-workspace-rebind'
import { workspaceNameFromPath } from '@/lib/workspace/shorten-path'
import { workspacePathsMatch } from '@/stores/session-utils'

/**
 * The folder is already a workspace in this team, registered by another agent.
 *
 * `POST /v1/workspaces` dedupes on the team's path before anything else and
 * keeps the row's agent, so re-adding the folder hands back that agent's row —
 * and a seat only takes a workspace of its own agent. Two machines that lay
 * their home out identically land here.
 */
export class WorkspaceHeldByAnotherAgentError extends Error {
  constructor(readonly path: string) {
    super(`workspace ${path} belongs to another agent in this team`)
    this.name = 'WorkspaceHeldByAnotherAgentError'
  }
}

/**
 * Whether the files pane may offer to bind a folder for the agent: its seat in
 * the session is confirmed to hold no workspace, or one there is nothing to run
 * in any more.
 *
 * All the pane knows is that the session resolved to no folder, and a failed
 * participant read or a workspace missing from this machine's list ends there
 * too. A pick made then would overwrite a seat that is bound, so anything short
 * of a confirmed answer is false — and a failed read throws.
 */
export async function localSeatNeedsWorkspace(args: {
  teamId: string
  sessionId: string
  agentId: string
}): Promise<boolean> {
  const backend = getBackend()
  const participants = await backend.sessions.getSessionParticipants(args.sessionId)
  const seat = participants.find((p) => p.actor_id === args.agentId)
  if (!seat) return false
  const workspaceId = seat.workspaceId?.trim()
  if (!workspaceId) return true

  const [row] = await backend.workspaces.listWorkspacesByIds(args.teamId, [workspaceId])
  // Gone, archived, or never given a directory. `archived` is missing from an
  // older Cloud API; missing counts as live.
  return !row || row.archived === true || !row.path
}

/** The agent's live workspace for `path`, registering the folder when it is not one yet. */
export async function ensureAgentWorkspaceForPath(args: {
  teamId: string
  agentId: string
  memberId: string | null
  path: string
}): Promise<DaemonWorkspace> {
  const existing = (await listDaemonWorkspaces(args.teamId, args.agentId)).find(
    (w) => !w.archived && !!w.path && workspacePathsMatch(w.path, args.path),
  )
  if (existing) return existing

  const saved = await createDaemonWorkspace({
    teamId: args.teamId,
    agentId: args.agentId,
    createdByMemberId: args.memberId,
    name: workspaceNameFromPath(args.path),
    path: args.path,
  })
  if (saved.agentId !== args.agentId) throw new WorkspaceHeldByAnotherAgentError(args.path)
  return saved
}

/**
 * Move the agent's seat onto `workspace`, then bring what follows the seat
 * along: this viewer's local binding, the files pane, the window, the runtime.
 *
 * Throws only when the seat itself could not be written. Everything after it
 * is best-effort and self-heals on the next open or send.
 */
export async function bindSessionAgentWorkspace(args: {
  teamId: string
  sessionId: string
  agentId: string
  viewerMemberId: string | null
  workspace: { id: string; path: string }
}): Promise<void> {
  const { teamId, sessionId, agentId, workspace } = args
  await getBackend().sessionMembers.setParticipantWorkspace(sessionId, agentId, workspace.id)

  // The session list groups by this row, and the outbox fast path starts the
  // runtime from it.
  if (args.viewerMemberId) {
    try {
      await upsertSessionWorkspacesBatch([
        {
          sessionId,
          teamId,
          viewerMemberId: args.viewerMemberId,
          agentId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          updatedAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      console.warn('[session-agent-workspace] local binding write failed (non-fatal):', e)
    }
  }

  // A folder registered a moment ago is not in the cached id → path map yet.
  invalidateViewerWorkspaceContext(teamId)
  noteSessionWorkspaceRebound(sessionId)

  // The user may have moved on while the seat was written; only the session on
  // screen gets to move the window.
  const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
  if (useSessionSelectionStore.getState().currentSessionId === sessionId) {
    const { switchToSessionWorkspaceIfNeeded } = await import('@/lib/session/session-by-workspace')
    await switchToSessionWorkspaceIfNeeded(teamId, sessionId).catch((e) =>
      console.warn('[session-agent-workspace] window did not follow the new folder (non-fatal):', e),
    )
  }

  // A runtime the fallbacks started elsewhere is superseded by a start in the
  // seat's folder; with none running this starts one, as adding the agent does.
  // An ensure still running from opening the session read the seat before it
  // moved, so this one waits for it and starts again rather than joining it.
  const { ensureAgentRuntimesForSession } = await import('@/lib/teamclu/ensure-agent-runtime')
  void ensureAgentRuntimesForSession({
    sessionId,
    teamId,
    agentActorIds: [agentId],
    workspaceIdHint: workspace.id,
    reason: 'session_workspace_bound',
    afterInFlight: true,
  }).catch((e) => console.warn('[session-agent-workspace] runtime start failed (non-fatal):', e))
}
