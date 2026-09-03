import { nameMatchesToken, parseAtMentionNames } from "@/lib/actor/resolve-text-mentions";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";

/**
 * Is this message addressed only to people on the other end of a channel?
 *
 * A gateway chat is a solo session — one human, one agent — so the composer's
 * agent pill is put there automatically and put back the moment it is removed.
 * It therefore says nothing about intent, and the "clear the agent" branch of
 * the mention confirm is a no-op in exactly the sessions where an external can
 * be mentioned at all. What the user typed is the only signal left: naming the
 * person on the WeCom end and nobody else means "send this to them", not "and
 * also wake the agent up to comment on it".
 *
 * Requires the roster to know each mentioned id: an unresolved id could be a
 * member, and dropping the agent on a guess would silently stop answering.
 */
export function mentionsOnlyExternals(
  mentionIds: string[],
  roster: Array<{
    actorId: string;
    isAgent: boolean;
    isExternal: boolean;
    displayName: string;
  }>,
  messageText: string,
): boolean {
  if (mentionIds.length === 0 || roster.length === 0) return false;
  const known = new Map(roster.map((p) => [p.actorId, p] as const));
  for (const id of mentionIds) {
    const row = known.get(id);
    if (!row || !row.isExternal) return false;
  }
  // A typed `@AgentName` in the body is an explicit ask, even alongside one.
  const agents = roster.filter((p) => p.isAgent);
  for (const token of parseAtMentionNames(messageText)) {
    if (agents.some((a) => nameMatchesToken(a.displayName, token))) return false;
  }
  return true;
}

/**
 * When the composer already has an engaged/preselected agent and the body has
 * no free-form `@Name` tokens, mention_actor_ids need no network round-trip.
 * Returns null when async resolution is still required (solo fallback, @text).
 */
export function trySyncMentionActorIds(
  memberIds: string[],
  agentIds: string[],
  messageText: string,
): string[] | null {
  if (parseAtMentionNames(messageText).length > 0) return null;
  if (agentIds.length === 0) return null;
  return Array.from(new Set([...memberIds, agentIds[0]!]));
}

/**
 * Team id for an outgoing message, in strict priority order:
 * session-list row → the session's own team from the backend → selected team.
 *
 * The backend lookup must outrank the selected team: a session missing from the
 * (capped, lazily-loaded) list would otherwise be sent under the wrong team and
 * the Cloud insert would fail.
 */
/**
 * The team to send into: the session's own row if the list has it, else the
 * team you are currently in.
 *
 * There used to be a middle step that asked the backend to resolve a team from
 * a bare session id. It is gone on purpose — session reads are team-scoped now,
 * and a composer is always inside the team you are looking at, so the current
 * team is the right answer whenever the list row has not loaded yet. Removing
 * it also drops a network round-trip from the send path.
 */
export function resolveSendTeamId(args: {
  teamIdFromSessionList: string | null;
  currentTeamId: () => string | null;
}): string | null {
  return args.teamIdFromSessionList ?? args.currentTeamId();
}

/**
 * Pick agent ids for model selection / pending-reply marking without a fresh
 * listParticipants call when the pill or roster cache already knows the agent.
 */
export function resolveAgentRuntimeIdsForSend(
  sessionId: string,
  agentForSendId: string | null | undefined,
  mentionActorIds: string[],
): string[] {
  if (agentForSendId) return [agentForSendId];

  const cached =
    useSessionParticipantStore.getState().participantsBySession[sessionId];
  if (cached && cached.length > 0) {
    const agents = new Set(
      cached.filter((participant) => participant.isAgent).map((p) => p.actorId),
    );
    return mentionActorIds.filter((id) => agents.has(id));
  }

  const engaged = useEngagedAgentStore.getState().get(sessionId);
  if (engaged?.id && mentionActorIds.includes(engaged.id)) {
    return [engaged.id];
  }

  return [];
}
