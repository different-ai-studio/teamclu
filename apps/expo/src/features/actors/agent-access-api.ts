import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";
import type {
  AgentAuthorizedHuman,
  ConnectedAgent,
} from "./connected-agent-types";

/**
 * Cloud-only agent-access provider. Mirrors the iOS CloudAPIAgentAccessRepository:
 * connected agents (with isOwner), authorized-human grants, agent visibility,
 * plus canManageAgent (owner-gating via the permission endpoint). Daemon routing
 * uses the agent's actor id (== agentId); there is no separate device id lookup.
 */

// FC connected-agent item shape (mapConnectedAgent).
type CloudConnectedAgent = {
  id: string;
  displayName?: string | null;
  agentTypes?: string[] | null;
  defaultAgentType?: string | null;
  permissionLevel?: string | null;
  visibility?: string | null;
  isOwner?: boolean | null;
  lastActiveAt?: string | null;
};

// FC agent-access item shape (mapAgentAccess).
type CloudAgentAccess = {
  actorId: string;
  memberName?: string | null;
  role?: string | null;
  permissionLevel?: string | null;
  grantedByMemberId?: string | null;
  lastActiveAt?: string | null;
  actorType?: string | null;
};

function toConnectedAgent(row: CloudConnectedAgent): ConnectedAgent {
  return {
    agentId: row.id,
    displayName: row.displayName ?? "",
    agentTypes: Array.isArray(row.agentTypes)
      ? row.agentTypes.filter((t): t is string => typeof t === "string")
      : [],
    defaultAgentType: row.defaultAgentType ?? null,
    permissionLevel: row.permissionLevel ?? "prompt",
    visibility: row.visibility === "personal" ? "personal" : "team",
    isOwner: Boolean(row.isOwner),
    lastActiveAt: row.lastActiveAt ?? null,
  };
}

export type AgentAccessApi = {
  listConnectedAgents: (teamId: string) => Promise<ConnectedAgent[]>;
  shareAgentToTeam: (agentId: string) => Promise<void>;
  makeAgentPersonal: (agentId: string) => Promise<void>;
  listAuthorizedHumans: (agentId: string) => Promise<AgentAuthorizedHuman[]>;
  grantAuthorizedHuman: (
    agentId: string,
    memberId: string,
    permissionLevel: string,
    grantedByMemberId: string,
  ) => Promise<void>;
  revokeAuthorizedHuman: (agentId: string, memberId: string) => Promise<void>;
  /** Owner-gating: true when the caller owns the agent (permission endpoint). */
  canManageAgent: (agentId: string, memberActorId: string) => Promise<boolean>;
  /** The member's access role on the agent (`owner` / `admin` / …), or null. */
  agentAccessRole: (agentId: string, memberActorId: string) => Promise<string | null>;
};

export function createAgentAccessApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): AgentAccessApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  return {
    async listConnectedAgents(teamId) {
      if (!teamId) return [];
      const result = await client.get<{ items: CloudConnectedAgent[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/agents/connected`,
      );
      return (result.items ?? []).map(toConnectedAgent);
    },

    async shareAgentToTeam(agentId) {
      await client.post(`/v1/agents/${encodeURIComponent(agentId)}/share-to-team`, {});
    },

    async makeAgentPersonal(agentId) {
      await client.post(`/v1/agents/${encodeURIComponent(agentId)}/make-personal`, {});
    },

    async listAuthorizedHumans(agentId) {
      const result = await client.get<{ items: CloudAgentAccess[] }>(
        `/v1/agents/${encodeURIComponent(agentId)}/access`,
      );
      return (result.items ?? [])
        .filter((row) => (row.actorType ?? "member") === "member")
        .map((row) => ({
          id: row.actorId,
          displayName: row.memberName?.trim() || "Unnamed",
          permissionLevel: row.role ?? row.permissionLevel ?? "prompt",
          grantedByActorId: row.grantedByMemberId ?? null,
          lastActiveAt: row.lastActiveAt ?? null,
        }));
    },

    async grantAuthorizedHuman(agentId, memberId, permissionLevel) {
      // grantedByMemberId is derived server-side from the bearer caller.
      await client.post(`/v1/agents/${encodeURIComponent(agentId)}/access`, {
        actorId: memberId,
        role: permissionLevel,
      });
    },

    async revokeAuthorizedHuman(agentId, memberId) {
      await client.del(
        `/v1/agents/${encodeURIComponent(agentId)}/access/${encodeURIComponent(memberId)}`,
      );
    },

    async canManageAgent(agentId, memberActorId) {
      if (!memberActorId) return false;
      const result = await client.get<{ allowed: boolean; role: string | null }>(
        `/v1/agents/${encodeURIComponent(agentId)}/permission?actorId=${encodeURIComponent(memberActorId)}`,
      );
      return result?.role === "owner";
    },
    async agentAccessRole(agentId, memberActorId) {
      if (!memberActorId) return null;
      const result = await client.get<{ allowed: boolean; role: string | null }>(
        `/v1/agents/${encodeURIComponent(agentId)}/permission?actorId=${encodeURIComponent(memberActorId)}`,
      );
      return result?.allowed ? result.role ?? null : null;
    },
  };
}
