import {
  cloudApiBaseUrl,
  createCloudApiClient,
  CloudApiError,
} from "../../lib/cloud-api/client";
import {
  mapMessageRecord,
  type SessionMessage,
  type SessionSummary,
} from "./session-types";

type CreateCloudSessionsApiOptions = {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type SessionMode = "solo" | "collab" | "control";

type OutgoingMessageInput = {
  id: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  createdAt?: string;
  metadata?: unknown | null;
  model?: string | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
  attachments?: unknown[] | null;
};

type CloudSessionFull = {
  id: string;
  teamId: string;
  title: string | null;
  mode: string;
  ideaId: string | null;
  primaryAgentId: string | null;
  createdByActorId: string | null;
  summary: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  participantCount: number;
  hasUnread: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type CloudMessage = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId: string | null;
  senderActorId: string | null;
  replyToMessageId: string | null;
  kind: string;
  content: string;
  metadata: unknown | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
  attachments?: unknown | null;
};

/** A row of `session_participants`, joined to the actor directory. */

/** "Helpful" / "Not helpful" on an agent reply (`/v1/feedback`, iOS `setFeedback`). */
export type FeedbackKind = "positive" | "negative";

export type MessageFeedbackRecord = {
  messageId: string;
  actorId: string;
  kind: FeedbackKind;
};

export type SessionParticipantRecord = {
  actorId: string;
  actorType: string | null;
  displayName: string;
  role: string | null;
  /** Agent's workspace for this session (ADR-0005); null on member rows. */
  workspaceId: string | null;
  /** Agent's model for this session; null on member rows. */
  model: string | null;
  avatarUrl: string | null;
};

/** Server-side cap in FC's `parseLimit`; a larger `limit` is rejected as a 400. */
const MAX_PAGE_SIZE = 100;

/**
 * Walks `GET /v1/sessions?teamId=…` to exhaustion.
 *
 * Replaces `GET /v1/teams/:teamId/sessions`, which returned a team's whole
 * session list in one response. That endpoint fell over on large teams: it
 * counted participants with a query that put every session id in the URL,
 * which crossed the gateway's request-line limit and surfaced as an opaque
 * 500. The replacement is paginated, so a caller that wants everything pages.
 */
async function listAllTeamSessions(
  client: { get: <T>(path: string) => Promise<T> },
  teamId: string,
): Promise<CloudSessionFull[]> {
  // Bounded so a server that keeps returning a cursor cannot spin forever.
  const MAX_PAGES = 100;
  const all: CloudSessionFull[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ teamId, limit: String(MAX_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const response = await client.get<{ items?: CloudSessionFull[]; nextCursor?: string | null }>(
      `/v1/sessions?${params.toString()}`,
    );
    all.push(...(response.items ?? []));
    cursor = response.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  return all;
}

function mapSession(row: CloudSessionFull): SessionSummary {
  return {
    sessionId: row.id,
    teamId: row.teamId,
    title: row.title ?? "",
    summary: row.summary ?? "",
    participantCount: row.participantCount ?? 0,
    // The session list does not expose the participant actor id list. The only
    // consumer (mention resolver) treats it as advisory and falls back to the
    // full team directory, so an empty list is safe.
    participantActorIds: [],
    lastMessagePreview: row.lastMessagePreview ?? "",
    lastMessageAt: row.lastMessageAt ?? "",
    createdAt: row.createdAt ?? "",
    createdBy: row.createdByActorId ?? "",
    hasUnread: row.hasUnread ?? false,
  };
}

function mapMessage(row: CloudMessage): SessionMessage {
  // Reuse the canonical record mapper (attachment coercion + defaults) by
  // projecting the camelCase Cloud API row onto the snake_case record shape.
  return mapMessageRecord({
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
    attachments: row.attachments,
  });
}

export function createCloudSessionsApi(options: CreateCloudSessionsApiOptions) {
  const client = createCloudApiClient({
    getAccessToken: options.getAccessToken,
    baseUrl: options.baseUrl ?? cloudApiBaseUrl(),
    fetchImpl: options.fetchImpl,
  });

  // Bound to a name only so the object has one; callers destructure it, so no
  // method may reach a sibling through `this`.
  const api = {
    async listSessions(teamId: string, currentActorId?: string): Promise<SessionSummary[]> {
      // currentActorId is derived server-side from the bearer; kept for
      // signature parity with the legacy Supabase implementation.
      void currentActorId;
      return (await listAllTeamSessions(client, teamId)).map(mapSession);
    },

    async listSessionsForIdea(
      teamId: string,
      ideaId: string,
      limit = 5,
    ): Promise<SessionSummary[]> {
      // Filtered by the server. This used to pull the whole team list and
      // filter in the client, which only worked because the old endpoint was
      // unpaginated — against a paginated one it would silently miss matches
      // that fall on a later page. Rows come back ordered by last_message_at
      // desc, so a plain limit is the top-N.
      const params = new URLSearchParams({
        teamId,
        ideaId,
        limit: String(Math.min(limit, MAX_PAGE_SIZE)),
      });
      const response = await client.get<{ items?: CloudSessionFull[] }>(
        `/v1/sessions?${params.toString()}`,
      );
      return (response.items ?? []).map(mapSession);
    },

    async getSession(teamId: string, sessionId: string): Promise<SessionSummary | null> {
      // teamId is required on session reads — it resolves the caller's actor
      // (one actor row per user per team) and scopes the lookup, so an id from
      // another team is a 404 rather than an RLS-filtered empty row.
      try {
        const row = await client.get<CloudSessionFull>(
          `/v1/sessions/${encodeURIComponent(sessionId)}?teamId=${encodeURIComponent(teamId)}`,
        );
        return mapSession(row);
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return null;
        throw error;
      }
    },

    // One page of history, newest-last, walking BACKWARD: no cursor gives the
    // tail of the conversation and `nextCursor` reaches older pages. The server
    // caps the page (it used to return the whole history, which took 6.1s /
    // 3.7MB at 6k messages and 500'd past ~40k).
    async listMessagesPage(
      teamId: string,
      sessionId: string,
      opts: { limit?: number; cursor?: string | null } = {},
    ): Promise<{ items: SessionMessage[]; nextCursor: string | null }> {
      void teamId;
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const query = params.toString();
      const response = await client.get<{ items?: CloudMessage[]; nextCursor?: string | null }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ""}`,
      );
      return {
        items: (response.items ?? []).map(mapMessage),
        nextCursor: response.nextCursor ?? null,
      };
    },

    async insertOutgoingMessage(input: OutgoingMessageInput): Promise<void> {
      if (!input.id) {
        throw new Error("Cloud API message insert requires a stable message id.");
      }
      const body: Record<string, unknown> = {
        id: input.id,
        teamId: input.teamId,
        senderActorId: input.senderActorId,
        kind: "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: input.model ?? null,
        turnId: input.turnId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
      };
      if (input.attachments && input.attachments.length > 0) {
        body.attachments = input.attachments;
      }
      if (input.createdAt) {
        body.createdAt = input.createdAt;
      }
      await client.post(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        body,
        { idempotencyKey: input.id },
      );
    },

    async resolveMemberActorId(teamId: string, userId: string): Promise<string | null> {
      const params = new URLSearchParams({ teamId, userId });
      const result = await client.get<{ id?: string } | null>(
        `/v1/directory/current-member-actor?${params.toString()}`,
      );
      return result?.id ?? null;
    },

    async updateMessageContent(messageId: string, content: string): Promise<void> {
      await client.patch(`/v1/messages/${encodeURIComponent(messageId)}`, { content });
    },

    async deleteMessage(messageId: string): Promise<void> {
      await client.del(`/v1/messages/${encodeURIComponent(messageId)}`);
    },

    /** All feedback on a session's messages; callers keep their own. */
    async listFeedback(sessionId: string): Promise<MessageFeedbackRecord[]> {
      const params = new URLSearchParams({ sessionId });
      const out = await client.get<{ items?: Array<Record<string, unknown>> } | null>(
        `/v1/feedback?${params.toString()}`,
      );
      return (out?.items ?? []).flatMap((row) => {
        const messageId = typeof row.messageId === "string" ? row.messageId : "";
        const actorId = typeof row.actorId === "string" ? row.actorId : "";
        const kind = row.kind === "positive" || row.kind === "negative" ? row.kind : null;
        return messageId && actorId && kind ? [{ messageId, actorId, kind }] : [];
      });
    },

    async submitFeedback(input: {
      messageId: string;
      actorId: string;
      teamId: string;
      sessionId: string | null;
      kind: FeedbackKind;
    }): Promise<void> {
      await client.post("/v1/feedback", {
        messageId: input.messageId,
        actorId: input.actorId,
        teamId: input.teamId,
        sessionId: input.sessionId,
        kind: input.kind,
      });
    },

    async deleteFeedback(messageId: string, actorId: string): Promise<void> {
      const params = new URLSearchParams({ actorId });
      await client.del(`/v1/feedback/${encodeURIComponent(messageId)}?${params.toString()}`);
    },

    async renameSession(sessionId: string, title: string): Promise<void> {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { title });
    },

    async setSessionArchived(sessionId: string, archivedAt: string | null): Promise<void> {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { archivedAt });
    },

    async createSession(input: {
      teamId: string;
      title: string;
      mode?: SessionMode;
      primaryAgentId?: string | null;
      ideaId?: string | null;
    }): Promise<string> {
      const response = await client.post<{ sessionId?: string; id?: string }>("/v1/sessions", {
        teamId: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        primaryAgentId: input.primaryAgentId ?? null,
        ideaId: input.ideaId ?? null,
      });
      const sessionId = response?.sessionId ?? response?.id;
      if (!sessionId || typeof sessionId !== "string") {
        throw new Error("create_session returned no session id");
      }
      return sessionId;
    },

    async markSessionRead(
      sessionId: string,
      actorId: string,
      lastMessageId: string | null,
    ): Promise<void> {
      // The current actor is derived from the bearer server-side.
      void actorId;
      await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-viewed`, {
        lastReadMessageId: lastMessageId,
      });
    },

    async markSessionUnread(sessionId: string, actorId: string): Promise<void> {
      void actorId;
      await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-unread`);
    },

    async addParticipants(
      sessionId: string,
      actorIds: ReadonlyArray<string>,
    ): Promise<void> {
      // FC's participants POST is single-actor + idempotent (upsert on
      // session_id,actor_id), so we loop one call per actor.
      for (const actorId of actorIds) {
        if (!actorId) continue;
        await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, {
          actorId,
        });
      }
    },

    async removeParticipant(sessionId: string, actorId: string): Promise<void> {
      await client.del(
        `/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(actorId)}`,
      );
    },

    /**
     * Participants with their per-session agent state.
     *
     * `workspaceId` and `model` used to live on `agent_runtimes`; that table
     * was dropped on 2026-08-03 and the columns were backfilled onto
     * `session_participants` (ADR-0005). This is the endpoint iOS reads for
     * the member sheet, and the reason `/v1/sessions/:id/runtime-models`,
     * `/v1/agents/runtimes` and `/v1/runtime/:id/model` are gone — all three
     * answered 404 on the live API.
     *
     * Live runtime facts (status, available models) are not here: they arrive
     * over MQTT as retained `ActorPresence` (ADR-0004).
     */
    async listSessionParticipants(
      sessionId: string,
    ): Promise<SessionParticipantRecord[]> {
      type Row = {
        actorId?: string | null;
        actorType?: string | null;
        displayName?: string | null;
        role?: string | null;
        workspaceId?: string | null;
        model?: string | null;
        avatarUrl?: string | null;
      };
      const response = await client.get<{ items?: Row[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
      );
      return (response.items ?? [])
        .filter((row): row is Row & { actorId: string } => Boolean(row.actorId))
        .map((row) => ({
          actorId: row.actorId,
          actorType: row.actorType ?? null,
          displayName: row.displayName ?? "",
          role: row.role ?? null,
          workspaceId: row.workspaceId ?? null,
          model: row.model ?? null,
          avatarUrl: row.avatarUrl ?? null,
        }));
    },
  };

  return api;
}
