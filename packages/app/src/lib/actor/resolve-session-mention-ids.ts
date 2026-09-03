import { getBackend } from "@/lib/backend";
import { isAgentActorType } from "@/lib/actor/actor-type";
import { resolveActorIdsFromAtText } from "@/lib/actor/resolve-text-mentions";
import { isSoloAgentSession } from "@/lib/session/session-empty-thread-starters";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import {
  useSessionParticipantStore,
} from "@/stores/session-participant-store";

function soleAgentIdFromRoster(
  roster: Array<{ isAgent: boolean; isExternal?: boolean; actorId: string }>,
): string | null {
  const solo = isSoloAgentSession(
    roster.map((p) => ({ isAgent: p.isAgent, isExternal: p.isExternal ?? false })),
  );
  if (!solo) return null;
  return roster.find((p) => p.isAgent)?.actorId ?? null;
}

async function resolveSoleAgentIdIfSoloSession(sessionId: string): Promise<string | null> {
  const store = useSessionParticipantStore.getState();
  const cached = store.participantsBySession[sessionId];
  const loading = store.loadingBySession[sessionId] ?? false;
  // An empty roster is "not loaded yet", not "nobody is here" — falling through
  // to the cloud read below is what keeps a cron-created session answerable.
  // Trusting the empty array here is what sent messages with no target.
  if (cached !== undefined && cached.length > 0 && !loading) {
    return soleAgentIdFromRoster(cached);
  }

  try {
    const rows = await getBackend().sessionMembers.listParticipants(sessionId);
    const roster = rows
      .filter(
        (row) =>
          row.actor_type === "member" ||
          row.actor_type === "external" ||
          isAgentActorType(row.actor_type),
      )
      .map((row) => ({
        actorId: row.id,
        isAgent: isAgentActorType(row.actor_type),
        isExternal: row.actor_type === "external",
      }));
    return soleAgentIdFromRoster(roster);
  } catch {
    return null;
  }
}

/**
 * Resolve `mention_actor_ids` for an outgoing message — WYSIWYG only.
 *
 * Agent routing follows what the user explicitly chose:
 * - engaged-agent pill in the composer footer
 * - `@displayName` typed in the message body
 * - human member @ tokens / picker mentions (memberIds)
 *
 * There is no send-time fallback that silently @-mentions a session agent,
 * except in solo sessions (exactly one human + one agent) where routing must
 * stay reliable while the roster or pill is still loading.
 */
export async function resolveSessionMentionActorIds(
  sessionId: string,
  memberIds: string[],
  agentIds: string[],
  messageText = "",
  options: { skipSoloAgentFallback?: boolean } = {},
): Promise<string[]> {
  const fromText = await resolveActorIdsFromAtText(sessionId, messageText);

  // Keep the pill in sync when the user typed `@AgentName` inline.
  if (fromText.agentIds.length > 0) {
    const engaged = useEngagedAgentStore.getState();
    let participants: Array<{ id: string; display_name?: string | null }>;
    try {
      participants = await getBackend().sessionMembers.listParticipants(sessionId);
    } catch {
      participants = [];
    }
    for (const agentId of fromText.agentIds) {
      const row = participants.find((p) => p.id === agentId);
      engaged.addAgent(sessionId, {
        id: agentId,
        displayName: row?.display_name || "AI",
      });
      break;
    }
  }

  let effectiveAgentIds = agentIds.slice(0, 1);
  // `skipSoloAgentFallback` is the caller saying this message names only
  // people reachable through a channel. The fallback exists for messages that
  // name nobody; applying it here would answer an explicit "@ this person"
  // with "and the agent too".
  if (
    !options.skipSoloAgentFallback &&
    effectiveAgentIds.length === 0 &&
    fromText.agentIds.length === 0
  ) {
    const soleAgentId = await resolveSoleAgentIdIfSoloSession(sessionId);
    if (soleAgentId) effectiveAgentIds = [soleAgentId];
  }

  return Array.from(
    new Set([
      ...memberIds,
      ...effectiveAgentIds,
      ...fromText.memberIds,
      ...(fromText.agentIds[0] ? [fromText.agentIds[0]] : []),
    ]),
  );
}
