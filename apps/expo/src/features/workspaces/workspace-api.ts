import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

/**
 * Cloud-only workspaces provider. Mirrors the iOS CloudAPIWorkspaceRepository
 * read path and adds the create/patch operations the Expo workspaces screen
 * needs. Identity comes from the bearer token; FC derives the user server-side.
 *
 * FC `mapWorkspace` returns the camelCase shape
 * `{ id, teamId, name, path, slug, agentId, createdByMemberId, archived, ... }`.
 * Agent binding rides on PATCH `{ agentId }` (FC patchWorkspace maps it to the
 * `agent_id` column; null unbinds).
 */
export type Workspace = {
  id: string;
  teamId: string;
  name: string;
  path: string | null;
  agentId: string | null;
  archived: boolean;
};

type CloudWorkspace = {
  id: string;
  teamId: string;
  name: string;
  path?: string | null;
  agentId?: string | null;
  archived?: boolean | null;
};

function toWorkspace(row: CloudWorkspace): Workspace {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    path: row.path ?? null,
    agentId: row.agentId ?? null,
    archived: row.archived === true,
  };
}

export type WorkspacesApi = {
  /**
   * One page (200) of the team's workspaces. Pass `agentId` to list only that
   * agent's rows — a large team's single page can miss the one you need
   * (iOS `listWorkspaces(teamID:agentID:)`).
   */
  list: (teamId: string, options?: { agentId?: string | null }) => Promise<Workspace[]>;
  create: (input: {
    teamId: string;
    name: string;
    createdByMemberId: string;
  }) => Promise<Workspace>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  setPath: (id: string, path: string | null) => Promise<void>;
  bindAgent: (id: string, agentId: string | null) => Promise<void>;
};

export function createWorkspacesApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): WorkspacesApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  return {
    async list(teamId, options) {
      if (!teamId) return [];
      const agentId = options?.agentId?.trim();
      const agentQuery = agentId ? `&agentId=${encodeURIComponent(agentId)}` : "";
      const result = await client.get<{ items: CloudWorkspace[] }>(
        `/v1/workspaces?teamId=${encodeURIComponent(teamId)}&limit=200${agentQuery}`,
      );
      return (result.items ?? []).map(toWorkspace);
    },
    async create(input) {
      const row = await client.post<CloudWorkspace>("/v1/workspaces", {
        teamId: input.teamId,
        name: input.name,
        createdByMemberId: input.createdByMemberId,
        archived: false,
      });
      return toWorkspace(row);
    },
    async setArchived(id, archived) {
      await client.patch(`/v1/workspaces/${encodeURIComponent(id)}`, { archived });
    },
    async setPath(id, path) {
      await client.patch(`/v1/workspaces/${encodeURIComponent(id)}`, { path });
    },
    async bindAgent(id, agentId) {
      await client.patch(`/v1/workspaces/${encodeURIComponent(id)}`, { agentId });
    },
  };
}
