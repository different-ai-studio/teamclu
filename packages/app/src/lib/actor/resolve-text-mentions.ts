import { getBackend } from "@/lib/backend";
import { isAgentActorType } from "@/lib/actor/actor-type";

/** Matches @Name tokens; excludes @{filepath} file mentions. */
const AT_MENTION_RE = /@([^\s@#{]+)/g;

export function parseAtMentionNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(AT_MENTION_RE)) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith("{")) continue;
    names.push(raw);
  }
  return [...new Set(names)];
}

export function nameMatchesToken(displayName: string, token: string): boolean {
  const dn = displayName.trim().toLowerCase();
  const t = token.trim().toLowerCase();
  if (!dn || !t) return false;
  return dn === t || dn.startsWith(t) || t.startsWith(dn);
}

type TextMentionResolution = {
  agentIds: string[];
  memberIds: string[];
};

/**
 * Resolve @displayName tokens in free-form message text to session participant
 * actor ids. Used when the user types "@MACPRO ..." without picking from the
 * mention popover (which only updates engaged-agent pills).
 */
export async function resolveActorIdsFromAtText(
  sessionId: string,
  text: string,
): Promise<TextMentionResolution> {
  const names = parseAtMentionNames(text);
  if (names.length === 0) {
    return { agentIds: [], memberIds: [] };
  }

  let participants: Awaited<
    ReturnType<ReturnType<typeof getBackend>["sessionMembers"]["listParticipants"]>
  >;
  try {
    participants = await getBackend().sessionMembers.listParticipants(sessionId);
  } catch {
    return { agentIds: [], memberIds: [] };
  }

  const agentIds: string[] = [];
  const memberIds: string[] = [];

  for (const name of names) {
    const row = participants.find((p) =>
      nameMatchesToken(p.display_name || "", name),
    );
    if (!row) continue;
    if (isAgentActorType(row.actor_type)) {
      agentIds.push(row.id);
    } else {
      memberIds.push(row.id);
    }
  }

  return {
    agentIds: [...new Set(agentIds)],
    memberIds: [...new Set(memberIds)],
  };
}
