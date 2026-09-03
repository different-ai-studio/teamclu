import type { MessageHistoryRow } from "@/lib/backend/types";
import type { MessageRow } from "@/lib/cache/local-cache";

/** Map Cloud API history rows into local-cache MessageRow shape. */
export function historyRowsToMessageRows(
  rows: MessageHistoryRow[],
  opts?: { teamId?: string; origin?: string },
): MessageRow[] {
  const teamId = opts?.teamId ?? "";
  const origin = opts?.origin ?? "cloud_api";
  const now = new Date().toISOString();

  return rows.map((r) => {
    const metadataJson =
      r.metadata == null
        ? null
        : typeof r.metadata === "string"
          ? r.metadata
          : JSON.stringify(r.metadata);
    const partsJson =
      Array.isArray(r.parts) && r.parts.length > 0
        ? JSON.stringify(r.parts)
        : null;
    return {
      id: r.id,
      teamId: r.team_id || teamId,
      sessionId: r.session_id,
      turnId: r.turn_id ?? null,
      senderActorId: r.sender_actor_id ?? null,
      replyToMessageId: r.reply_to_message_id ?? null,
      kind: r.kind,
      content: r.content ?? "",
      metadataJson,
      model: r.model ?? null,
      mentionsJson: r.mentions ? JSON.stringify(r.mentions) : null,
      origin,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at,
      deletedAt: null,
      syncedAt: now,
      partsJson,
    };
  });
}
