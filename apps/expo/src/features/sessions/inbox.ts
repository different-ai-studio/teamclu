/**
 * FC's inbox ping — `inbox/<auth user id>` (`services/fc/src/lib/push-dispatch.ts`):
 * `{ v, type, team_id, session_id, message_id, ts }`. It only says "something
 * changed in this session"; unread flags are recomputed server-side, so the
 * client re-reads the session list. Mirrors iOS `parseInboxEnvelope` (#1555).
 *
 * Returns the session id to refresh for, or null when the ping is malformed or
 * belongs to another team. A missing `team_id` (v1 payloads) is accepted.
 */
export function inboxTopic(authUserId: string): string | null {
  const id = authUserId.trim();
  // An empty id would subscribe `inbox/`, which matches nothing useful.
  return id ? `inbox/${id}` : null;
}

export function parseInboxPing(payload: Uint8Array | string, currentTeamId: string): string | null {
  let text: string;
  try {
    text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const sessionId = typeof record.session_id === "string" ? record.session_id.trim() : "";
  if (!sessionId) return null;
  const type = typeof record.type === "string" ? record.type : "message";
  if (type !== "message") return null;
  const teamId = typeof record.team_id === "string" ? record.team_id : null;
  if (teamId && currentTeamId && teamId !== currentTeamId) return null;
  return sessionId;
}
