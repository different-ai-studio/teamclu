import type { RemoteToolInvokeRequest, RpcRequest } from '@/lib/proto/teamclu_pb'
import { getBackend } from '@/lib/backend'
import { useActorDirectoryStore } from '@/stores/actor-directory-store'
import { useSessionParticipantStore } from '@/stores/session-participant-store'

export function isAgentRequesterForRemoteToolRequest(
  teamId: string,
  request: RpcRequest,
): boolean {
  const requester = request.requesterActorId.trim()
  if (!requester) return false
  return requesterIsAgentInDirectory(teamId, requester)
}

function requesterIsAgentInDirectory(teamId: string, requester: string): boolean {
  const actors = useActorDirectoryStore.getState().byTeam[teamId]?.actors ?? []
  const requesterRow = actors.find((a) => a.id === requester)
  return requesterRow?.actor_type === 'agent'
}

function requesterIsAgentInParticipants(
  participants: Array<{ actorId: string; isAgent: boolean }>,
  requester: string,
): boolean {
  return participants.some((p) => p.actorId === requester && p.isAgent)
}

/**
 * Reject forged member→member rpc/req injections. Legitimate remote-tool calls
 * are published by the session's agent daemon (`requester_actor_id` = agent).
 *
 * Sync check — use only when stores are already warm (tests).
 */
export function isAllowedRemoteToolRequest(
  teamId: string,
  request: RpcRequest,
  invoke: RemoteToolInvokeRequest,
): boolean {
  const requester = request.requesterActorId.trim()
  if (!requester) return false

  const sessionId = invoke.sessionId.trim()
  if (!sessionId) return false

  if (!requesterIsAgentInDirectory(teamId, requester)) {
    return false
  }

  const participants =
    useSessionParticipantStore.getState().participantsBySession[sessionId]
  if (!participants || participants.length === 0) {
    return false
  }

  return requesterIsAgentInParticipants(participants, requester)
}

/**
 * Authorize a remote-tool RPC on capable clients (extension). Loads participants
 * from Cloud API when the store is cold or poisoned with an empty cache entry.
 */
export async function authorizeRemoteToolRequest(
  teamId: string,
  request: RpcRequest,
  invoke: RemoteToolInvokeRequest,
): Promise<boolean> {
  const requester = request.requesterActorId.trim()
  if (!requester) return false

  const sessionId = invoke.sessionId.trim()
  if (!sessionId) return false

  let requesterIsAgent = requesterIsAgentInDirectory(teamId, requester)
  if (!requesterIsAgent) {
    const row = await getBackend().actors.getActorDirectoryEntry(requester)
    requesterIsAgent = row?.actor_type === 'agent'
  }
  if (!requesterIsAgent) return false

  await useSessionParticipantStore.getState().ensureParticipants([sessionId])
  let participants =
    useSessionParticipantStore.getState().participantsBySession[sessionId]
  if (!participants || participants.length === 0) {
    const apiRows = await getBackend().sessionMembers.listParticipants(sessionId, { fresh: true })
    participants = apiRows.map((actor) => ({
      actorId: actor.id,
      displayName: actor.display_name ?? actor.id,
      avatarUrl: actor.avatar_url ?? null,
      isAgent: actor.actor_type === 'agent',
      isExternal: actor.actor_type === 'external',
    }))
  }

  return requesterIsAgentInParticipants(participants, requester)
}
