import { getBackend } from '@/lib/backend'
import { workspacePathsMatch } from '@/stores/session-utils'
import {
  rememberDefaultWorkspaceId,
} from '@/stores/agent-default-workspace-store'

/** Inputs for picking the cloud workspace id sent in runtimeStart. */
type AgentWorkspaceLookup = {
  /** Explicit hint from send/outbox — highest priority. */
  callerWorkspaceId?: string | null
  /** Latest `agent_runtimes.workspace_id` for this agent *in this session*. */
  sessionWorkspaceId?: string | null
  /** `agents.default_workspace_id` from actor directory. */
  defaultWorkspaceId?: string | null
  /** First non-archived `workspaces` row bound to this agent. */
  ownedWorkspaceId?: string | null
  /** Cloud returned a participant row for this agent (workspace_id may still be null). */
  participantSeen?: boolean
}

/**
 * Cloud workspace UUID to pass in `runtimeStart.workspaceId`.
 * Never returns a local filesystem path — the target daemon resolves `path`
 * from its own `workspaces.toml` via `remote_workspace_id`.
 *
 * Priority: caller hint (send/outbox) → this session's prior runtime → agent
 * default → agent-owned workspace. Team-wide cross-session hints are
 * intentionally excluded so a runtime in workspace A from another conversation
 * cannot leak into session B.
 */
export function resolveAgentRuntimeWorkspaceId(lookup: AgentWorkspaceLookup): string {
  for (const candidate of [
    lookup.callerWorkspaceId,
    lookup.sessionWorkspaceId,
    lookup.defaultWorkspaceId,
    lookup.ownedWorkspaceId,
  ]) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * runtimeStart payload. The daemon resolves `workspaceId` -> path itself and
 * only falls back to `worktree` when that yields nothing — which is exactly
 * what happens for an app session, whose cloud workspace row carries no path:
 * the daemon then spawned in the onboarded default workspace and the agent ran
 * against the wrong directory.
 *
 * `worktree` is a path on THIS machine, so pass it only when the target agent
 * is the local daemon. Sending it to a remote daemon would name a directory
 * that does not exist there (or, worse, a different one that does).
 */
export function runtimeStartWorkspaceArgs(
  workspaceId: string,
  localWorktree = '',
): {
  workspaceId: string
  worktree: string
} {
  return { workspaceId, worktree: localWorktree.trim() }
}

/**
 * Batch-load workspace hints for a set of agents in one session. Safe to call
 * once per startAgentRuntimesAsync fanout.
 */
export async function loadAgentWorkspaceLookups(
  teamId: string,
  sessionId: string,
  agentActorIds: string[],
): Promise<Map<string, AgentWorkspaceLookup>> {
  const ids = [...new Set(agentActorIds.map((id) => id.trim()).filter(Boolean))]
  const out = new Map<string, AgentWorkspaceLookup>()
  if (ids.length === 0) return out

  const backend = getBackend()
  const [actorRows, workspaceRows] = await Promise.all([
    backend.actors.listActorDirectoryByIds(ids).catch(() => []),
    backend.workspaces.listDaemonWorkspaces(teamId).catch(() => []),
  ])

  for (const id of ids) {
    out.set(id, {})
  }

  if (sessionId.trim()) {
    // The participant row owns this agent's workspace for this session
    // (ADR-0005) — one call for the whole session instead of one per agent
    // against a team-wide runtime table.
    try {
      const participants = await backend.sessions.getSessionParticipants(sessionId)
      for (const row of participants) {
        const existing = out.get(row.actor_id)
        if (!existing) continue
        existing.participantSeen = true
        const workspaceId = row.workspaceId?.trim()
        if (workspaceId) existing.sessionWorkspaceId = workspaceId
      }
    } catch {
      // offline — fall through to defaults.
    }
  }

  for (const row of actorRows) {
    const agentId = row.id?.trim()
    if (!agentId || !out.has(agentId)) continue
    const existing = out.get(agentId)!
    if (!existing.defaultWorkspaceId && row.default_workspace_id?.trim()) {
      existing.defaultWorkspaceId = row.default_workspace_id
    }
  }

  for (const row of workspaceRows) {
    if (row.archived) continue
    const agentId = row.agent_id?.trim()
    if (!agentId || !out.has(agentId)) continue
    const existing = out.get(agentId)!
    if (!existing.ownedWorkspaceId && row.id?.trim()) {
      existing.ownedWorkspaceId = row.id
    }
  }

  return out
}

/** Path key used for exact window-root matching (no realpath). */
export function workspacePathKey(path: string | null | undefined): string | null {
  if (path == null) return null
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed) return null
  const isAbs = trimmed.startsWith('/')
  const parts: string[] = []
  for (const seg of trimmed.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(seg)
  }
  const joined = parts.join('/')
  if (isAbs) return joined ? `/${joined}` : '/'
  return joined || null
}

/**
 * Map the desktop user's local workspace folder to a cloud workspace UUID by
 * matching `workspaces.path` on the team.
 */
export async function resolveCloudWorkspaceIdForLocalPath(
  teamId: string,
  localWorkspacePath: string,
  opts?: { agentActorId?: string | null },
): Promise<string | null> {
  const trimmedTeam = teamId.trim()
  const trimmedPath = localWorkspacePath.trim()
  const agentFilter = opts?.agentActorId?.trim() || null
  if (!trimmedTeam || !trimmedPath) return null

  const wanted = workspacePathKey(trimmedPath)
  if (!wanted) return null

  const rows = await getBackend().workspaces.listDaemonWorkspaces(trimmedTeam).catch(() => [])
  const matches: { id: string; agentId: string }[] = []
  for (const row of rows) {
    if (row.archived) continue
    const cloudId = row.id?.trim()
    const daemonPath = row.path?.trim()
    if (!cloudId || !daemonPath) continue
    const key = workspacePathKey(daemonPath)
    if (key === wanted || workspacePathsMatch(trimmedPath, daemonPath)) {
      matches.push({ id: cloudId, agentId: row.agent_id?.trim() || '' })
    }
  }
  if (matches.length === 0) return null
  if (agentFilter) {
    const owned = matches.find((row) => row.agentId === agentFilter)
    if (owned) return owned.id
  }
  return matches[0]!.id
}

/**
 * Create-time only: exact path match, or create. An explicit window path must
 * never fall through to the agent's first owned workspace (`bound[0]`).
 */
export async function ensureWorkspaceForNewSessionContext(args: {
  teamId: string
  agentActorId: string
  localWorkspacePath: string
  createdByMemberId?: string | null
}): Promise<string> {
  return ensureCloudWorkspaceIdForAgentRuntime({
    teamId: args.teamId,
    agentActorId: args.agentActorId,
    localWorkspacePath: args.localWorkspacePath,
    createdByMemberId: args.createdByMemberId,
  })
}

/**
 * Existing-session only: `session_participants.workspace_id`. Never creates,
 * never reads the window path, never uses the device default cache.
 */
export async function resolveBoundWorkspaceForExistingSession(args: {
  teamId: string
  sessionId: string
  agentActorId: string
}): Promise<string> {
  const agentActorId = args.agentActorId.trim()
  const sessionId = args.sessionId.trim()
  if (!agentActorId || !sessionId || !args.teamId.trim()) return ''
  const lookups = await loadAgentWorkspaceLookups(args.teamId, sessionId, [agentActorId]).catch(
    () => new Map<string, AgentWorkspaceLookup>(),
  )
  return lookups.get(agentActorId)?.sessionWorkspaceId?.trim() || ''
}

/**
 * Resolve or create the cloud workspace UUID for runtimeStart.workspaceId.
 * Never returns a filesystem path.
 *
 * Deliberately resolves **live only**, unlike
 * `resolveSessionWorkspaceHintForRuntimeStart`. Here a non-empty answer is an
 * existence claim — "this path already has a cloud workspace, don't create one"
 * — and a remembered id from a previous run cannot support that claim. Reading
 * the cache here suppressed `createDaemonWorkspace` for a directory that had no
 * workspace at all, leaving the runtime bound to one whose path is somewhere
 * else entirely. The cache exists to avoid a slow start, not to answer whether
 * a row exists.
 */
export async function ensureCloudWorkspaceIdForAgentRuntime(args: {
  teamId: string
  agentActorId: string
  localWorkspacePath?: string | null
  sessionId?: string
  createdByMemberId?: string | null
}): Promise<string> {
  const agentActorId = args.agentActorId.trim()
  if (!agentActorId || !args.teamId.trim()) return ''

  const path = args.localWorkspacePath?.trim()
  if (path) {
    const exact = await resolveCloudWorkspaceIdForLocalPath(args.teamId, path, {
      agentActorId,
    })
    if (exact) {
      rememberDefaultWorkspaceId([agentActorId], exact)
      return exact
    }
  } else {
    return ''
  }

  const name = path.split('/').filter(Boolean).pop() || 'workspace'
  try {
    const created = await getBackend().workspaces.createDaemonWorkspace({
      teamId: args.teamId,
      agentId: agentActorId,
      createdByMemberId: args.createdByMemberId ?? null,
      name,
      path,
    })
    const id = created.id?.trim() || ''
    // A workspace we just created is as live as it gets — seed the cache with
    // it so the next send skips the lookup round trip.
    if (id) rememberDefaultWorkspaceId([agentActorId], id)
    return id
  } catch {
    return ''
  }
}

/**
 * Best-effort workspace hint for runtimeStart on the outbox/send path.
 * Prefer the current local workspace binding; fall back to per-session /
 * per-agent backend lookups when path matching fails.
 */
export async function resolveSessionWorkspaceHintForRuntimeStart(args: {
  teamId: string
  localWorkspacePath?: string | null
  sessionId?: string
  agentActorIds?: string[]
  /** When set, local-path matching only considers workspaces bound to this agent. */
  localDaemonActorId?: string | null
}): Promise<string> {
  const agentActorIds = [...new Set((args.agentActorIds ?? []).map((id) => id.trim()).filter(Boolean))]
  const sessionId = args.sessionId?.trim() ?? ''
  const localDaemonActorId = args.localDaemonActorId?.trim()
  if (sessionId) {
    const agentId = localDaemonActorId || agentActorIds[0] || ''
    if (!agentId) return ''
    return resolveBoundWorkspaceForExistingSession({
      teamId: args.teamId,
      sessionId,
      agentActorId: agentId,
    })
  }

  const live = await resolveLiveWorkspaceHint(args, agentActorIds)
  if (live) {
    rememberDefaultWorkspaceId(agentActorIds, live)
    return live
  }
  return ''
}

/**
 * This session's own workspace binding for the local daemon, read from the
 * local cache alone — no Cloud API, no daemon IPC.
 *
 * The synchronous send path cannot await {@link resolveSessionWorkspaceHintForRuntimeStart}:
 * that one starts with a Cloud round trip, and paying it before the runtime
 * starts is the 7–8s of dead air the fast path exists to avoid. But its only
 * synchronous alternative — `cachedDefaultWorkspaceId` — is a *device*-level
 * default for the agent, with no session in it: send the first message in a
 * freshly created app and the runtime started in whichever app was open
 * before, so the agent read and wrote another app's files while the new app
 * deployed as the untouched seed template.
 *
 * The binding this reads is written when the session is bound to its app
 * (`bindAppWorkspace`), so it is already on disk by the time the user can
 * type. A session with no cached row yields null and the caller falls back —
 * cold cache behaves exactly as before.
 */
export async function cachedSessionWorkspaceForLocalDaemon(args: {
  teamId: string
  sessionId: string
  localDaemonActorId: string
}): Promise<{ workspaceId: string; workspacePath: string } | null> {
  const teamId = args.teamId.trim()
  const sessionId = args.sessionId.trim()
  const agentId = args.localDaemonActorId.trim()
  if (!teamId || !sessionId || !agentId) return null
  try {
    const { useCurrentTeamStore } = await import('@/stores/current-team')
    const viewerMemberId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? ''
    if (!viewerMemberId) return null
    const { loadSessionWorkspacesForTeam } = await import('@/lib/cache/local-cache')
    const rows = await loadSessionWorkspacesForTeam(teamId, viewerMemberId)
    const row = rows.find((r) => r.sessionId === sessionId && r.agentId === agentId)
    const workspaceId = row?.workspaceId?.trim() ?? ''
    const workspacePath = row?.workspacePath?.trim() ?? ''
    if (!workspaceId && !workspacePath) return null
    return { workspaceId, workspacePath }
  } catch {
    return null
  }
}

/** The original chain: session binding → local path → per-agent lookups. */
async function resolveLiveWorkspaceHint(
  args: {
    teamId: string
    localWorkspacePath?: string | null
    sessionId?: string
    localDaemonActorId?: string | null
  },
  agentActorIds: string[],
): Promise<string> {

  const localPath = args.localWorkspacePath?.trim()
  const localDaemonActorId = args.localDaemonActorId?.trim()

  // The session's own workspace binding outranks `localWorkspacePath`, which
  // is ambient UI state (the workspace store) and lags a session switch by a
  // background round trip. Sending in a just-opened app otherwise resolved to
  // whichever app happened to be open before, and the agent ran there.
  if (localDaemonActorId && args.sessionId?.trim()) {
    const { resolveSessionWorkspacePath } = await import('@/lib/session/session-by-workspace')
    const bound = (
      await resolveSessionWorkspacePath(args.teamId, args.sessionId.trim()).catch(() => null)
    )?.trim()
    if (bound) {
      const fromSession = await resolveCloudWorkspaceIdForLocalPath(args.teamId, bound, {
        agentActorId: localDaemonActorId,
      })
      if (fromSession) return fromSession
    }
  }

  if (localPath && localDaemonActorId) {
    const fromPath = await resolveCloudWorkspaceIdForLocalPath(args.teamId, localPath, {
      agentActorId: localDaemonActorId,
    })
    if (fromPath) return fromPath
    return ''
  }

  const sessionId = args.sessionId?.trim() ?? ''
  if (sessionId && agentActorIds.length > 0) {
    const lookups = await loadAgentWorkspaceLookups(args.teamId, sessionId, agentActorIds).catch(
      () => new Map<string, AgentWorkspaceLookup>(),
    )
    for (const agentId of agentActorIds) {
      const bound = lookups.get(agentId)?.sessionWorkspaceId?.trim()
      if (bound) return bound
    }
  }

  return ''
}
