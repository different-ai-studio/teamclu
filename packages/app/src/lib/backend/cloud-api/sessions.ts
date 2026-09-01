import type {
  SessionCreateInput,
  SessionDetailRow,
  SessionDisplayRow,
  SessionListCursor,
  SessionListPage,
  SessionParticipant,
  SessionSyncRow,
  SessionsBackend,
} from "../types";
import { rememberThreadForkFromSessionDetail } from "@/lib/thread-fork-metadata";
import { CloudApiError, type CloudApiClient } from "./http";
import { fetchAllSyncPages } from "./sync-paging";

type CloudSession = {
  id: string;
  teamId: string;
  title: string;
  mode: "solo" | "collab" | "control";
  ideaId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  hasUnread: boolean;
  source?: string | null;
  cronJobId?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type CloudSessionDetail = CloudSession & {
  primaryAgentId?: string | null;
  createdByActorId?: string | null;
  summary?: string | null;
  acpSessionId?: string | null;
  binding?: string | null;
  parentSessionId?: string | null;
  threadRootMessageId?: string | null;
};

function mapSessionDetail(row: CloudSessionDetail): SessionDetailRow {
  const mapped: SessionDetailRow = {
    id: row.id,
    team_id: row.teamId,
    title: row.title,
    mode: row.mode,
    idea_id: row.ideaId,
    primary_agent_id: row.primaryAgentId ?? null,
    created_by_actor_id: row.createdByActorId ?? null,
    summary: row.summary ?? null,
    last_message_at: row.lastMessageAt,
    last_message_preview: row.lastMessagePreview,
    acp_session_id: row.acpSessionId ?? null,
    binding: row.binding ?? null,
    source: row.source ?? null,
    cron_job_id: row.cronJobId ?? null,
    parent_session_id: row.parentSessionId ?? null,
    thread_root_message_id: row.threadRootMessageId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  rememberThreadForkFromSessionDetail(mapped);
  return mapped;
}

type Page<T> = { items: T[]; nextCursor: string | null };

function mapSession(row: CloudSession) {
  return {
    id: row.id,
    title: row.title,
    team_id: row.teamId,
    last_message_at: row.lastMessageAt,
    last_message_preview: row.lastMessagePreview,
    mode: row.mode,
    idea_id: row.ideaId,
    has_unread: row.hasUnread,
    source: row.source ?? null,
    cron_job_id: row.cronJobId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function encodeCursor(cursor: SessionListCursor): string {
  if (typeof cursor === "string") return cursor;
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createSessionsModule(client: CloudApiClient): SessionsBackend {
  return {
    async listCurrentActorSessions(args: {
      limit: number;
      cursor: SessionListCursor | null;
      teamId: string;
      kind?: "all" | "regular" | "cron";
    }): Promise<SessionListPage> {
      // Without this an undefined teamId serializes to the literal string
      // "undefined", which sails past the server's truthiness check and reaches
      // the RPC as a malformed uuid — a 500 where a 400 was intended.
      const teamId = args.teamId?.trim();
      if (!teamId) throw new Error("listCurrentActorSessions requires teamId");
      const params = new URLSearchParams({
        limit: String(args.limit),
        teamId,
        kind: args.kind ?? "all",
      });
      if (args.cursor) params.set("cursor", encodeCursor(args.cursor));
      const page = await client.get<Page<CloudSession>>(`/v1/sessions?${params.toString()}`);
      return { rows: page.items.map(mapSession), nextCursor: page.nextCursor };
    },
    async markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null) {
      await client.post<void>(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-viewed`, { lastReadMessageId: lastReadMessageId ?? null });
    },
    async createSessionShell(input: SessionCreateInput) {
      await client.post<CloudSession>("/v1/sessions", {
        id: input.id,
        teamId: input.teamId,
        title: input.title,
        mode: "collab",
        createdByActorId: input.createdByActorId,
        ideaId: input.ideaId ?? null,
        additionalActorIds: input.additionalActorIds,
        ...(input.appId ? { appId: input.appId } : {}),
      });
      return { sessionId: input.id };
    },
    async addParticipants(sessionId, actorIds) {
      const unique = Array.from(new Set(actorIds));
      for (const actorId of unique) {
        try {
          await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, { actorId });
        } catch (e) {
          // Idempotent: ignore conflicts.
          if (e instanceof CloudApiError && (e.status === 409 || e.status === 200)) continue;
          throw e;
        }
      }
    },
    async updateSessionTitle(sessionId, title) {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { title });
    },
    async archiveSession(sessionId, archivedAt) {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { archivedAt });
    },
    async getSessionParticipants(sessionId): Promise<SessionParticipant[]> {
      const out = await client.get<{
        items: Array<{
          sessionId?: string;
          actorId: string;
          role?: string | null;
          workspaceId?: string | null;
          model?: string | null;
          lastProcessedMessageId?: string | null;
        }>;
      }>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`);
      return out.items.map((row) => ({
        session_id: row.sessionId ?? sessionId,
        actor_id: row.actorId,
        role: row.role ?? null,
        // The agent's working state for this session (ADR-0005). The server has
        // returned all three since that migration and `SessionParticipant` has
        // always declared them — this mapper just dropped them, so every client
        // read `undefined` regardless of what the row held.
        workspaceId: row.workspaceId ?? null,
        model: row.model ?? null,
        lastProcessedMessageId: row.lastProcessedMessageId ?? null,
      }));
    },
    async getSession(sessionId, teamId) {
      try {
        const teamQuery =
          typeof teamId === "string" && teamId.length > 0
            ? `?teamId=${encodeURIComponent(teamId)}`
            : "";
        const out = await client.get<CloudSessionDetail>(
          `/v1/sessions/${encodeURIComponent(sessionId)}${teamQuery}`,
        );
        return mapSessionDetail(out);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async joinSession(sessionId: string): Promise<SessionDetailRow> {
      const out = await client.post<CloudSessionDetail>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/join`,
        {},
      );
      return mapSessionDetail(out);
    },
    // Pages to exhaustion. This route was already paginated server-side
    // (default 50) while this client read only `items` off the first response,
    // so any team with more than 50 changes since the last watermark lost the
    // remainder on every sync.
    async listSessionsForTeamSince(teamId, updatedAfter): Promise<SessionSyncRow[]> {
      return fetchAllSyncPages<SessionSyncRow>(client, "/v1/sync/sessions", {
        teamId,
        since: updatedAfter ?? null,
      });
    },
    async listSessionDisplayRows(teamId, sessionIds): Promise<SessionDisplayRow[]> {
      if (sessionIds.length === 0) return [];
      const out = await client.post<{ items: SessionDisplayRow[] }>(`/v1/sessions/display-rows`, {
        teamId,
        sessionIds,
      });
      return out.items ?? [];
    },
    async createThread(parentSessionId, rootMessageId) {
      const out = await client.post<CloudSessionDetail>(
        `/v1/sessions/${encodeURIComponent(parentSessionId)}/threads`,
        { rootMessageId },
      );
      return mapSessionDetail(out);
    },
    async listThreadSummaries(parentSessionId) {
      const out = await client.get<{
        items: Array<{
          threadSessionId: string;
          rootMessageId: string;
          messageCount: number;
          lastMessageAt: string | null;
          participantCount: number;
        }>;
      }>(`/v1/sessions/${encodeURIComponent(parentSessionId)}/thread-summaries`);
      return out.items ?? [];
    },
  };
}
