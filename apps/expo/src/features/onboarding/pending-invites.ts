/**
 * Invites addressed to the signed-in user's verified email/phone
 * (`GET /v1/invites/pending`), shown on the no-team screen. Mirrors iOS
 * `PendingInvite` / `CloudAPIAppOnboardingStore.listPendingInvites`.
 */
export type PendingInvite = {
  /** inviteId — the accept/decline routing key. */
  id: string;
  teamId: string;
  teamName: string | null;
  teamRole: string | null;
  invitedByDisplayName: string | null;
};

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Drops rows without an inviteId/teamId rather than failing the whole list. */
export function parsePendingInvites(body: unknown): PendingInvite[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: PendingInvite[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = optStr(r.inviteId);
    const teamId = optStr(r.teamId);
    if (!id || !teamId) continue;
    out.push({
      id,
      teamId,
      teamName: optStr(r.teamName),
      teamRole: optStr(r.teamRole),
      invitedByDisplayName: optStr(r.invitedByDisplayName),
    });
  }
  return out;
}
