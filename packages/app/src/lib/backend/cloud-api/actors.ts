import type {
  ActorDirectoryEntry,
  ActorsBackend,
  AgentAccessBackendRow,
  ClientVersionEntry,
  ConnectedAgentRow,
  TeamMemberOptionBackendRow,
} from "../types";
import type { CloudApiClient } from "./http";

type CloudActor = {
  id: string;
  teamId: string;
  kind: string;
  displayName: string;
  avatarUrl?: string | null;
  userId?: string | null;
  teamRole?: string | null;
  memberStatus?: string | null;
  agentStatus?: string | null;
  agentTypes?: string[] | null;
  defaultAgentType?: string | null;
  defaultWorkspaceId?: string | null;
  visibility?: string | null;
  agentOwnerMemberId?: string | null;
  email?: string | null;
  phone?: string | null;
  lastActiveAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  // External actors only: the gateway they came in through and their id in it.
  source?: string | null;
  sourceId?: string | null;
  // Only present on the single-actor detail response (GET /v1/actors/:id).
  clientVersions?: ClientVersionEntry[] | null;
};

type CloudConnectedAgent = CloudActor & {
  agentId?: string | null;
  permissionLevel?: string | null;
  isOwner?: boolean | null;
};

type CloudAgentAccess = {
  id: string;
  agentId: string;
  memberId: string;
  memberName?: string;
  permissionLevel: "view" | "prompt" | "admin";
  grantedByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

function mapActor(row: CloudActor): ActorDirectoryEntry {
  return {
    id: row.id,
    team_id: row.teamId,
    actor_type: row.kind,
    display_name: row.displayName ?? null,
    avatar_url: row.avatarUrl ?? null,
    user_id: row.userId ?? null,
    team_role: row.teamRole ?? null,
    member_status: row.memberStatus ?? null,
    agent_status: row.agentStatus ?? null,
    agent_types: row.agentTypes ?? null,
    default_agent_type: row.defaultAgentType ?? null,
    default_workspace_id: row.defaultWorkspaceId ?? null,
    visibility: row.visibility ?? null,
    agent_owner_member_id: row.agentOwnerMemberId ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    source: row.source ?? null,
    source_id: row.sourceId ?? null,
    last_active_at: row.lastActiveAt ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
    client_versions: row.clientVersions ?? null,
  };
}

function mapConnectedAgent(row: CloudConnectedAgent, teamId: string): ConnectedAgentRow {
  return {
    ...mapActor({ ...row, teamId: row.teamId ?? teamId }),
    agent_id: row.agentId ?? row.id,
    permission_level: row.permissionLevel ?? null,
    // The connected-agents endpoint computes ownership server-side (owner_member_id
    // === caller's team actor). Without forwarding it, the onboarding "bind existing"
    // filter (rows.filter(r => r.is_owner)) silently drops every owned agent.
    is_owner: row.isOwner === true,
  };
}

function mapAgentAccess(row: CloudAgentAccess): AgentAccessBackendRow {
  return {
    id: row.id,
    agentId: row.agentId,
    memberId: row.memberId,
    memberName: row.memberName ?? row.memberId,
    permissionLevel: row.permissionLevel,
    grantedByMemberId: row.grantedByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createActorsModule(client: CloudApiClient): ActorsBackend {
  return {
    async listActorDirectory(teamId) {
      const page = await client.get<Page<CloudActor>>(`/v1/teams/${encodeURIComponent(teamId)}/actors?limit=500`);
      return page.items.map(mapActor);
    },
    async listActorDirectoryByIds(actorIds) {
      if (actorIds.length === 0) return [];
      const out = await client.post<{ items: CloudActor[] }>(`/v1/actors/by-ids`, { actorIds });
      return out.items.map(mapActor);
    },
    async getActorDirectoryEntry(actorId) {
      try {
        return mapActor(await client.get<CloudActor>(`/v1/actors/${encodeURIComponent(actorId)}`));
      } catch {
        return null;
      }
    },
    async getDaemonAgentDirectoryEntry(_teamId, agentId) {
      try {
        return mapActor(await client.get<CloudActor>(`/v1/actors/${encodeURIComponent(agentId)}`));
      } catch {
        return null;
      }
    },
    async listConnectedAgents(teamId) {
      const out = await client.get<{ items: CloudConnectedAgent[] }>(`/v1/teams/${encodeURIComponent(teamId)}/agents/connected`);
      return out.items.map((row) => mapConnectedAgent(row, teamId));
    },
    async createAgentManagementGrant(agentId, scopes) {
      return client.post<{
        grant: string;
        expiresAt: string;
        requesterActorId: string;
        targetAgentId: string;
        scopes: string[];
      }>(`/v1/agents/${encodeURIComponent(agentId)}/management-grants`, { scopes });
    },
    async findAgentForDevice(input) {
      return await client.get<{ agentId: string | null; displayName: string | null }>(
        `/v1/teams/${encodeURIComponent(input.teamId)}/agents/for-device?deviceId=${encodeURIComponent(input.deviceId)}`,
      );
    },
    async ensureAgentForDevice(input) {
      return await client.post<{
        agentId: string;
        token: string;
        expiresAt: string | null;
        created: boolean;
      }>(`/v1/teams/${encodeURIComponent(input.teamId)}/agents/ensure-for-device`, {
        deviceId: input.deviceId,
        displayName: input.displayName,
      });
    },
    async updateOwnedAgentProfile(input) {
      await client.patch<void>(`/v1/agents/${encodeURIComponent(input.agentId)}`, {
        displayName: input.displayName ?? null,
        visibility: input.visibility ?? null,
      });
    },
    async updateCurrentActorProfile(input) {
      return mapActor(
        await client.patch<CloudActor>(`/v1/actors/${encodeURIComponent(input.actorId)}/profile`, {
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? null,
        }),
      );
    },
    async updateAgentDefaults(input) {
      const body: Record<string, unknown> = {};
      if (input.defaultAgentType !== undefined) body.defaultAgentType = input.defaultAgentType;
      if (input.agentTypes !== undefined) body.supportedAgentTypes = input.agentTypes;
      if (input.agentKind !== undefined) body.agentKind = input.agentKind;
      if (input.defaultWorkspaceId !== undefined) body.defaultWorkspaceId = input.defaultWorkspaceId;
      await client.patch<void>(`/v1/agents/${encodeURIComponent(input.agentId)}/defaults`, body);
    },
    async listAgentAccess(agentId) {
      const out = await client.get<{ items: CloudAgentAccess[] }>(`/v1/agents/${encodeURIComponent(agentId)}/access`);
      return out.items.map(mapAgentAccess);
    },
    async listTeamMembersForAccess(teamId) {
      const page = await client.get<Page<CloudActor>>(`/v1/teams/${encodeURIComponent(teamId)}/actors?kind=user&limit=500`);
      return page.items.map((row): TeamMemberOptionBackendRow => ({
        id: row.id,
        displayName: row.displayName || row.id,
        role: row.teamRole ?? null,
      }));
    },
    async upsertAgentAccess(input) {
      await client.post<CloudAgentAccess>(`/v1/agents/${encodeURIComponent(input.agentId)}/access`, {
        actorId: input.memberId,
        role: input.permissionLevel,
      });
    },
    async removeAgentAccess(accessId) {
      await client.delete<void>(`/v1/actors/access/${encodeURIComponent(accessId)}`);
    },
    async makeAgentPersonal(agentActorId: string): Promise<void> {
      await client.post<void>(
        `/v1/agents/${encodeURIComponent(agentActorId)}/make-personal`,
        {},
      );
    },
    async getMemberDefaultAgent(teamId: string): Promise<string | null> {
      const out = await client.get<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/members/me/default-agent`,
      );
      return out.defaultAgentId ?? null;
    },
    async setMemberDefaultAgent(teamId: string, agentId: string | null): Promise<string | null> {
      const out = await client.put<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/members/me/default-agent`,
        { agentId: agentId ?? null },
      );
      return out.defaultAgentId ?? null;
    },
    async getTeamDefaultAgent(teamId: string): Promise<string | null> {
      const out = await client.get<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/default-agent`,
      );
      return out.defaultAgentId ?? null;
    },
    async setTeamDefaultAgent(teamId: string, agentId: string | null): Promise<string | null> {
      const out = await client.put<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/default-agent`,
        { agentId: agentId ?? null },
      );
      return out.defaultAgentId ?? null;
    },
    async getEffectiveDefaultAgent(teamId: string): Promise<string | null> {
      const out = await client.get<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/members/me/effective-default-agent`,
      );
      return out.defaultAgentId ?? null;
    },
  };
}
