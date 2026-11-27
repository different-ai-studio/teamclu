import { getBackend } from '@/lib/backend'
import { getCurrentDaemonAgent } from '@/lib/daemon/daemon-agent-admin'

export interface DaemonWorkspace {
  id: string
  teamId: string
  agentId: string | null
  createdByMemberId: string | null
  name: string
  path: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface DaemonAgent {
  id: string
  displayName: string
  agentTypes: string[]
  defaultAgentType: string | null
  defaultWorkspaceId: string | null
  status: string | null
  lastActiveAt: string | null
}

function mapWorkspace(row: any): DaemonWorkspace {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id ?? null,
    createdByMemberId: row.created_by_member_id ?? null,
    name: row.name,
    path: row.path ?? null,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getCurrentDaemonWorkspaceAgent(teamId: string): Promise<DaemonAgent | null> {
  const agent = await getCurrentDaemonAgent(teamId)
  if (!agent) return null
  return {
    id: agent.id,
    displayName: agent.displayName,
    agentTypes: agent.agentTypes,
    defaultAgentType: agent.defaultAgentType,
    defaultWorkspaceId: agent.defaultWorkspaceId,
    status: agent.status ?? null,
    lastActiveAt: agent.lastActiveAt,
  }
}

export async function listDaemonWorkspaces(teamId: string, agentId?: string | null): Promise<DaemonWorkspace[]> {
  const data = await getBackend().workspaces.listDaemonWorkspaces(teamId, agentId)
  return data.map(mapWorkspace)
}

export async function createDaemonWorkspace(input: {
  /** Fill in an existing row (the app's own workspace) instead of inserting. */
  id?: string
  teamId: string
  agentId: string
  createdByMemberId: string | null
  name: string
  path: string
}): Promise<DaemonWorkspace> {
  const data = await getBackend().workspaces.createDaemonWorkspace(input)
  return mapWorkspace(data)
}

// Archiving a workspace archives its sessions, and restoring it brings back the
// ones that archive took — both inside the Cloud API (PATCH /v1/workspaces/:id),
// stamped with one instant so the restore can tell them from sessions archived
// by hand. This used to archive them a second time from here, one PATCH per
// session with its own timestamp, which overwrote that instant and left the
// restore nothing to match. All that is left to do here is pull the change
// into the local cache and repaint the list.
async function refreshSessionsAfterWorkspaceChange(teamId: string): Promise<void> {
  const { syncSessionsForTeam } = await import('@/lib/sync/session-sync')
  await syncSessionsForTeam(teamId)
  const { useSessionListStore } = await import('@/stores/session-list-store')
  await useSessionListStore.getState().load()
}

export async function updateDaemonWorkspace(input: {
  workspaceId: string
  name: string
  path: string
  archived: boolean
}): Promise<DaemonWorkspace> {
  const data = await getBackend().workspaces.updateDaemonWorkspace(input)
  const workspace = mapWorkspace(data)

  if (workspace.teamId) {
    void refreshSessionsAfterWorkspaceChange(workspace.teamId).catch((err) => {
      console.warn('[daemon-workspaces] failed to refresh sessions after workspace change:', err)
    })
  }

  return workspace
}

export async function setAgentDefaultWorkspace(agentId: string, workspaceId: string): Promise<void> {
  await getBackend().actors.updateAgentDefaults({
    agentId,
    defaultWorkspaceId: workspaceId,
  })
}
