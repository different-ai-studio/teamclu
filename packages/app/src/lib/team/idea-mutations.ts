import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'

export type IdeaStatus = 'open' | 'in_progress' | 'done'

interface IdeaForUpdate {
  workspace_id: string | null
  title: string
  description: string | null
  status: IdeaStatus | null
}

interface IdeaUpdateInput {
  workspaceId: string | null
  title: string
  description: string | null
  status: IdeaStatus
}

interface IdeaActivityInput {
  activityType: 'progress' | 'status_change' | 'reorder'
  content: string
  metadata?: Record<string, string>
}

async function fetchIdeaForUpdate(ideaId: string): Promise<IdeaForUpdate> {
  const data = await getBackend().ideas.getIdeaDetail(ideaId)
  if (!data) throw new Error('idea not found')
  return {
    workspace_id: data.workspace_id ?? null,
    title: data.title,
    description: data.description ?? null,
    status: (data.status as IdeaStatus | null) ?? null,
  }
}

export async function updateIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void> {
  const cur = await fetchIdeaForUpdate(ideaId)
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: cur.title,
    description: cur.description,
    status,
  })
}

export async function renameIdea(ideaId: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')
  const cur = await fetchIdeaForUpdate(ideaId)
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: trimmed,
    description: cur.description,
    status: cur.status ?? 'open',
  })
}

export async function updateIdea(ideaId: string, input: IdeaUpdateInput): Promise<void> {
  const trimmed = input.title.trim()
  if (!trimmed) throw new Error('title is required')
  await getBackend().ideas.updateIdea({
    ideaId,
    workspaceId: input.workspaceId,
    title: trimmed,
    description: input.description,
    status: input.status,
  })
}

/**
 * POST /v1/ideas/:id/activities requires the author's member actor id — the
 * server does not derive it from the bearer token. Normally that is the
 * current-team store's `currentMember`; when the store has not resolved yet,
 * fall back to resolving against the idea's own team.
 */
async function resolveActivityActorId(ideaId: string): Promise<string> {
  const member = useCurrentTeamStore.getState().currentMember
  if (member?.id) return member.id
  const backend = getBackend()
  const session = await backend.auth.getSession()
  const userId = session?.user.id
  if (userId) {
    const idea = await backend.ideas.getIdeaDetail(ideaId)
    if (idea?.team_id) {
      const resolved = await backend.directory.getCurrentTeamMember(idea.team_id, userId)
      if (resolved?.id) return resolved.id
    }
  }
  throw new Error('member actor not found for current user')
}

const STATUS_ACTIVITY_LABEL: Record<IdeaStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  done: 'Done',
}

/**
 * The server does not derive an activity from a status PATCH — the client that
 * made the change records it. Content and metadata match what iOS writes
 * (`IdeaStore.merge`), so each client can render the other's rows.
 */
export async function recordIdeaStatusChange(
  ideaId: string,
  from: IdeaStatus,
  to: IdeaStatus,
): Promise<void> {
  if (from === to) return
  await createIdeaActivity(ideaId, {
    activityType: 'status_change',
    content: `Changed status from ${STATUS_ACTIVITY_LABEL[from]} to ${STATUS_ACTIVITY_LABEL[to]}`,
    metadata: { from_status: from, to_status: to },
  })
}

export async function createIdeaActivity(ideaId: string, input: IdeaActivityInput): Promise<void> {
  const actorId = await resolveActivityActorId(ideaId)
  await getBackend().ideas.createIdeaActivity({
    ideaId,
    actorId,
    activityType: input.activityType,
    content: input.content,
    metadata: input.metadata ?? {},
  })
}
