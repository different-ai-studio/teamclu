/**
 * Tell each logged-in human member of a session that its roster changed.
 *
 * The payload is a hint to refetch the whole roster. It is not a chat message:
 * no message id, no mute filter, no APNs, and agents are not recipients.
 */

export interface MemberInboxLookup {
  teamId: string;
  userIds: string[];
}

export function removedMemberUserId(
  actor: { actor_type?: string | null; user_id?: string | null } | null | undefined,
): string | null {
  if (!actor || actor.actor_type !== "member") return null;
  const userId = actor.user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

export async function lookupMemberInboxRecipients(
  supabase: {
    from: (table: string) => any;
  },
  sessionId: string,
): Promise<MemberInboxLookup> {
  const { data: session, error: sessionErr } = await supabase
    .from("sessions")
    .select("team_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) throw sessionErr;
  const teamId = session?.team_id;
  if (typeof teamId !== "string" || teamId.length === 0) {
    throw new Error(`session ${sessionId} has no team_id`);
  }

  const { data: seats, error: seatErr } = await supabase
    .from("session_participants")
    .select("actor_id")
    .eq("session_id", sessionId);
  if (seatErr) throw seatErr;
  const actorIds = (seats ?? [])
    .map((row: { actor_id?: string | null }) => row.actor_id)
    .filter((id: string | null | undefined): id is string => typeof id === "string" && id.length > 0);
  if (actorIds.length === 0) return { teamId, userIds: [] };

  const { data: actors, error: actorErr } = await supabase
    .from("actors")
    .select("user_id")
    .in("id", actorIds)
    .eq("actor_type", "member");
  if (actorErr) throw actorErr;
  const userIds = (actors ?? [])
    .map((row: { user_id?: string | null }) => row.user_id)
    .filter((id: string | null | undefined): id is string => typeof id === "string" && id.length > 0);
  return { teamId, userIds };
}

export async function publishSessionParticipantsChanged(input: {
  sessionId: string;
  removedUserId?: string | null;
  lookup: () => Promise<MemberInboxLookup>;
  publish: (topic: string, body: string) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const { teamId, userIds } = await input.lookup();
  const recipients = new Set(userIds);
  if (input.removedUserId) recipients.add(input.removedUserId);
  if (recipients.size === 0) return;

  const body = JSON.stringify({
    v: 2,
    type: "session.participants",
    team_id: teamId,
    session_id: input.sessionId,
    ts: (input.now ?? Date.now)(),
  });
  const results = await Promise.allSettled(
    [...recipients].map((userId) => input.publish(`inbox/${userId}`, body)),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
}
