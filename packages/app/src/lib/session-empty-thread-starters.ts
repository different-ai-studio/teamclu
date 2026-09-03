import { isAgentActorType } from '@/lib/actor-type'

export type EmptyThreadParticipant = {
  actorId: string
  displayName: string
  isAgent: boolean
  isSelf: boolean
}

type EmptyThreadRoutingKind = 'soloAgent' | 'singleAgent' | 'multiAgent'

type SoloSessionParticipant =
  | { actor_type?: string | null }
  | (Pick<EmptyThreadParticipant, 'isAgent'> & { isExternal?: boolean })

function isAgentParticipant(p: SoloSessionParticipant): boolean {
  if ('isAgent' in p && typeof p.isAgent === 'boolean') return p.isAgent
  if ('actor_type' in p) return isAgentActorType(p.actor_type)
  return false
}

/** People who reached the session through a channel rather than an account.
 *  They joined the roster the moment the chat did, so counting them would make
 *  every gateway chat look like a group the instant it was created. */
function isExternalParticipant(p: SoloSessionParticipant): boolean {
  if ('isExternal' in p && typeof p.isExternal === 'boolean') return p.isExternal
  if ('actor_type' in p) return p.actor_type === 'external'
  return false
}

/** Exactly one agent and one other participant (solo human + agent pair).
 *  Adding another agent or member makes this false → agent pill becomes removable.
 *  External participants do not count: a WeCom DM is one human talking to one
 *  agent whether or not the person on the WeCom end is listed in the roster. */
export function isSoloAgentSession(participants: SoloSessionParticipant[]): boolean {
  const counted = participants.filter((p) => !isExternalParticipant(p))
  const agents = counted.filter(isAgentParticipant)
  return agents.length === 1 && counted.length === 2
}

export function resolveEmptyThreadRoutingKind(
  participants: EmptyThreadParticipant[],
): EmptyThreadRoutingKind {
  if (isSoloAgentSession(participants)) {
    return 'soloAgent'
  }
  const agents = participants.filter((p) => p.isAgent)
  if (agents.length === 1) {
    return 'singleAgent'
  }
  return 'multiAgent'
}

export function formatEmptyThreadRosterNames(
  participants: EmptyThreadParticipant[],
  selfLabel: string,
  nameSeparator: string,
): string {
  return participants
    .map((p) => (p.isSelf ? selfLabel : p.displayName))
    .join(nameSeparator)
}
