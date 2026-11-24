import type { DaemonWorkspaceBackendRow, WorkspacesBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

type CloudWorkspace = {
  id: string;
  teamId: string;
  agentId?: string | null;
  createdByMemberId?: string | null;
  name: string;
  /** Legacy API field — filesystem path is stored here in FC responses. */
  slug?: string | null;
  path?: string | null;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type Page<T> = { items: T[]; nextCursor: string | null };

/** The server's maximum `limit` for GET /v1/workspaces. */
const WORKSPACE_PAGE_SIZE = 200;
/** A guard against a cursor that never ends, not a size anyone should reach. */
const MAX_WORKSPACE_PAGES = 50;

function workspacePathFromCloud(row: Pick<CloudWorkspace, "path" | "slug">): string | null {
  return row.path?.trim() || row.slug?.trim() || null;
}

function mapWorkspace(row: CloudWorkspace): DaemonWorkspaceBackendRow {
  return {
    id: row.id,
    team_id: row.teamId,
    agent_id: row.agentId ?? null,
    created_by_member_id: row.createdByMemberId ?? null,
    name: row.name,
    path: workspacePathFromCloud(row),
    archived: row.archived,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  };
}

export function createWorkspacesModule(client: CloudApiClient): WorkspacesBackend {
  return {
    async listWorkspacesByIds(teamId, workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const out = await client.post<{
        items: Array<{
          id: string;
          name: string | null;
          path?: string | null;
          slug?: string | null;
          agentId?: string | null;
          archived?: boolean;
        }>;
      }>(`/v1/workspaces/by-ids`, { teamId, ids: workspaceIds });
      return (out.items ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? null,
        path: r.path?.trim() || r.slug?.trim() || null,
        agentId: r.agentId,
        archived: r.archived,
      }));
    },
    async listDaemonWorkspaces(teamId, agentId) {
      // Every page, not the first. Callers treat this as the whole list — "is
      // this session's folder on this machine", "which row has this path" — and
      // 200 is the server's page cap, not a bound on a team. A belayo team with
      // 345 rows had its app checkout at position 274, so every session of
      // that app showed an empty file tree ("读取不到该会话的工作目录").
      const out: DaemonWorkspaceBackendRow[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_WORKSPACE_PAGES; page += 1) {
        const params = new URLSearchParams({ teamId, limit: String(WORKSPACE_PAGE_SIZE) });
        if (agentId) params.set("agentId", agentId);
        if (cursor) params.set("cursor", cursor);
        const res: Page<CloudWorkspace> = await client.get<Page<CloudWorkspace>>(`/v1/workspaces?${params}`);
        out.push(...res.items.map(mapWorkspace));
        cursor = res.nextCursor ?? null;
        if (!cursor) return out;
      }
      console.warn(`[workspaces] stopped after ${MAX_WORKSPACE_PAGES} pages for team ${teamId}`);
      return out;
    },
    async createDaemonWorkspace(input) {
      const row = await client.post<CloudWorkspace>("/v1/workspaces", {
        // POST /v1/workspaces is an upsert: with an id it fills that row in
        // rather than inserting a second one for the same directory.
        ...(input.id ? { id: input.id } : {}),
        teamId: input.teamId,
        agentId: input.agentId,
        createdByMemberId: input.createdByMemberId,
        name: input.name,
        path: input.path,
        archived: false,
      });
      return mapWorkspace(row);
    },
    async updateDaemonWorkspace(input) {
      const row = await client.patch<CloudWorkspace>(`/v1/workspaces/${encodeURIComponent(input.workspaceId)}`, {
        name: input.name,
        path: input.path,
        archived: input.archived,
      });
      return mapWorkspace(row);
    },
  };
}
