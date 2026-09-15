import type { ActorDirectoryEntry, SessionMemberCandidate, SessionMembersBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import { createCoalescedRead } from "@/lib/backend/cloud-api/coalesced-read";

type CloudSessionParticipant = {
  sessionId: string;
  actorId: string;
  role?: string | null;
  joinedAt?: string | null;
  // enriched actor fields from FC (optional)
  displayName?: string | null;
  actorType?: string | null;
  teamId?: string | null;
};

function mapParticipant(row: CloudSessionParticipant): ActorDirectoryEntry {
  return {
    id: row.actorId,
    team_id: row.teamId ?? "",
    actor_type: row.actorType ?? null,
    display_name: row.displayName ?? null,
    avatar_url: null,
    user_id: null,
    team_role: row.role ?? null,
    member_status: null,
    agent_status: null,
    agent_types: null,
    default_agent_type: null,
    default_workspace_id: null,
    last_active_at: null,
    created_at: row.joinedAt ?? null,
    updated_at: null,
  };
}

type CloudActorEntry = {
  id: string;
  teamId: string;
  kind?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  userId?: string | null;
  teamRole?: string | null;
  memberStatus?: string | null;
  agentStatus?: string | null;
  agentTypes?: string[] | null;
  defaultAgentType?: string | null;
  defaultWorkspaceId?: string | null;
  lastActiveAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function mapActor(row: CloudActorEntry): ActorDirectoryEntry {
  return {
    id: row.id,
    team_id: row.teamId,
    actor_type: row.kind ?? null,
    display_name: row.displayName ?? null,
    avatar_url: row.avatarUrl ?? null,
    user_id: row.userId ?? null,
    team_role: row.teamRole ?? null,
    member_status: row.memberStatus ?? null,
    agent_status: row.agentStatus ?? null,
    agent_types: row.agentTypes ?? null,
    default_agent_type: row.defaultAgentType ?? null,
    default_workspace_id: row.defaultWorkspaceId ?? null,
    last_active_at: row.lastActiveAt ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

export function createSessionMembersModule(client: CloudApiClient): SessionMembersBackend {
  // A session always has its creator: an empty roster is a transient answer, never one to reuse.
  const participantsRead = createCoalescedRead<CloudSessionParticipant[]>({
    cacheable: (rows) => rows.length > 0,
  });
  return {
    async listParticipants(sessionId, listOptions) {
      const items = await participantsRead.get(
        sessionId,
        async () =>
          (
            await client.get<{ items: CloudSessionParticipant[] }>(
              `/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
            )
          ).items,
        { fresh: listOptions?.fresh },
      );
      return items.map(mapParticipant);
    },
    forgetParticipants(sessionId) {
      participantsRead.invalidate(sessionId);
    },
    async listSessionIdsForActor(actorId) {
      const out = await client.get<{ items: string[] }>(
        `/v1/actors/${encodeURIComponent(actorId)}/sessions`,
      );
      return out.items ?? [];
    },
    async listCandidateActors(teamId, presentActorIds) {
      // List all visible actors via /v1/teams/:teamId/actors and filter to
      // member/agent kinds not already present.
      const present = new Set(presentActorIds);
      const out = await client.get<{ items: CloudActorEntry[]; nextCursor: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/actors?limit=500`,
      );
      return out.items
        .map(mapActor)
        .filter((row) => row.actor_type === "member" || row.actor_type === "agent")
        .filter((row) => !present.has(row.id))
        .map((row): SessionMemberCandidate => ({ ...row, is_present: false }));
    },
    async addParticipant(sessionId, actorId) {
      try {
        await client.post<CloudSessionParticipant>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, { actorId, role: "member" });
      } finally {
        participantsRead.invalidate(sessionId);
      }
    },
    async setParticipantWorkspace(sessionId, actorId, workspaceId) {
      // The roster read above carries no workspace, so there is nothing to invalidate.
      await client.put<void>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(actorId)}/workspace`,
        { workspaceId },
      );
    },
    async removeParticipant(sessionId, actorId) {
      try {
        await client.delete<void>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(actorId)}`);
      } finally {
        participantsRead.invalidate(sessionId);
      }
    },
  };
}
