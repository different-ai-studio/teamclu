import type {
  MessageHistoryPage,
  MessageHistoryRow,
  MessagesBackend,
  OutgoingMessageInput,
} from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import { fetchAllSyncPages } from "@/lib/backend/cloud-api/sync-paging";

type CloudMessage = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId: string | null;
  senderActorId: string | null;
  replyToMessageId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
};

type Page<T> = { items: T[]; nextCursor: string | null };

function mapMessage(row: CloudMessage): MessageHistoryRow {
  return {
    id: row.id,
    team_id: row.teamId,
    session_id: row.sessionId,
    turn_id: row.turnId,
    sender_actor_id: row.senderActorId,
    reply_to_message_id: row.replyToMessageId,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata,
    model: row.model,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createMessagesModule(client: CloudApiClient): MessagesBackend {
  return {
    // Paginated backward from the newest message: no `cursor` yields the tail of
    // the history, and `nextCursor` walks into older pages. The server caps the
    // page, so omitting `limit` is not "give me everything" any more.
    async listMessages(
      sessionId: string,
      opts: { limit?: number; cursor?: string | null } = {},
    ): Promise<MessageHistoryPage> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const query = params.toString();
      const page = await client.get<Page<CloudMessage>>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ""}`,
      );
      return { rows: page.items.map(mapMessage), nextCursor: page.nextCursor ?? null };
    },
    async insertOutgoingMessage(input: OutgoingMessageInput): Promise<MessageHistoryRow> {
      const message = await client.post<CloudMessage>(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          id: input.id,
          teamId: input.teamId,
          senderActorId: input.senderActorId,
          content: input.content,
          kind: input.kind,
          metadata: input.metadata,
          turnId: input.turnId,
          replyToMessageId: input.replyToMessageId,
          model: input.model,
          createdAt: input.createdAt,
        },
        { idempotencyKey: input.id },
      );
      return mapMessage(message);
    },
    async updateMessageContent(messageId: string, content: string): Promise<void> {
      await client.patch<CloudMessage>(`/v1/messages/${encodeURIComponent(messageId)}`, { content });
    },
    // Pages to exhaustion — the route is keyset-paginated now, and a delta sync
    // that stopped at the first page would leave the local cache behind.
    async listMessagesForSessionSince(sessionId, updatedAfter) {
      return fetchAllSyncPages<import("@/lib/backend/types").MessageSyncRow>(client, "/v1/sync/messages", {
        sessionId,
        since: updatedAfter ?? null,
      });
    },
  };
}
