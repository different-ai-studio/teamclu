import type {
  AppsBackend,
  AppRow,
  AppDataRowsPage,
  AppDataRowsQuery,
  AppDataTable,
  AppSessionRow,
  AppGitCredential,
  AppGitHead,
  AppMembership,
  AppMemberAccessRow,
  AppPermissionLevel,
  DeployAppResult,
} from "../types";
import { CloudApiError, type CloudApiClient } from "./http";

type Page<T> = { items: T[] };

export function createAppsModule(client: CloudApiClient): AppsBackend {
  return {
    async listApps(teamId) {
      const params = new URLSearchParams({ teamId, limit: "100" });
      const page = await client.get<Page<AppRow>>(`/v1/apps?${params}`);
      return page.items;
    },
    async createApp(input) {
      return client.post<AppRow>("/v1/apps", input);
    },
    async getApp(appId) {
      try {
        return await client.get<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async listAppSessions(appId) {
      const page = await client.get<Page<AppSessionRow>>(`/v1/apps/${encodeURIComponent(appId)}/sessions`);
      return page.items;
    },
    async updateAppProvisionStatus(appId, provisionStatus) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { provisionStatus });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async updateAppDeployStatus(appId, fcStatus, deployError) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { fcStatus, deployError });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async renameApp(appId, name) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { name });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async deployApp(appId, input) {
      return client.post<DeployAppResult>(`/v1/apps/${encodeURIComponent(appId)}/deploy`, input);
    },
    async finalizeDeploy(appId, input) {
      return client.post<AppRow>(`/v1/apps/${encodeURIComponent(appId)}/deploy/finalize`, input);
    },
    async getGitCredential(appId) {
      try {
        return await client.get<AppGitCredential>(`/v1/apps/${encodeURIComponent(appId)}/git-credential`);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async revokeGitCredential(appId, deployKeyId) {
      try {
        await client.delete<{ revoked: boolean }>(
          `/v1/apps/${encodeURIComponent(appId)}/git-credential/${encodeURIComponent(String(deployKeyId))}`,
        );
      } catch (e) {
        // Tidiness, not correctness — the operation this follows has already
        // finished, and the server sweeps expired keys anyway.
        console.warn("revokeGitCredential failed (non-fatal)", e);
      }
    },
    async getGitHead(appId) {
      try {
        return await client.get<AppGitHead>(`/v1/apps/${encodeURIComponent(appId)}/git-head`);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async getAppMembership(appId) {
      try {
        return await client.get<AppMembership>(`/v1/apps/${encodeURIComponent(appId)}/membership`);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async listAppAccess(appId) {
      try {
        const page = await client.get<Page<AppMemberAccessRow>>(
          `/v1/apps/${encodeURIComponent(appId)}/access`,
        );
        return page.items;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async setAppAccess(appId, memberId, permissionLevel: AppPermissionLevel) {
      try {
        return await client.put<AppMemberAccessRow>(
          `/v1/apps/${encodeURIComponent(appId)}/access/${encodeURIComponent(memberId)}`,
          { permissionLevel },
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async removeAppAccess(appId, memberId) {
      try {
        await client.delete<{ ok: true }>(
          `/v1/apps/${encodeURIComponent(appId)}/access/${encodeURIComponent(memberId)}`,
        );
        return true;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return false;
        throw e;
      }
    },
    async deleteApp(appId) {
      try {
        await client.delete<{ ok: true }>(`/v1/apps/${encodeURIComponent(appId)}`);
        return true;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return false;
        throw e;
      }
    },
    async updateAppAuthMode(appId, authMode) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { authMode });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async listAppDataTables(appId) {
      try {
        const page = await client.get<Page<AppDataTable>>(
          `/v1/apps/${encodeURIComponent(appId)}/data/tables`,
        );
        return { status: "ok", tables: page.items };
      } catch (e) {
        if (!(e instanceof CloudApiError)) throw e;
        if (e.status === 404) return null;
        // Translated, not rethrown: each of these is a state the panel renders
        // as its own sentence, and a thrown error would collapse them into one
        // "something went wrong".
        if (e.code === "app_has_no_database") return { status: "no_database" };
        if (e.code === "app_not_deployed") return { status: "not_deployed" };
        if (e.status === 503 || e.code === "app_org_unknown") {
          return { status: "unavailable", reason: e.message };
        }
        throw e;
      }
    },

    async readAppDataRows(appId, table, query: AppDataRowsQuery = {}) {
      const params = new URLSearchParams();
      if (query.after) params.set("after", query.after);
      if (query.direction) params.set("direction", query.direction);
      if (query.limit) params.set("limit", String(query.limit));
      if (query.filter) {
        params.set("filterColumn", query.filter.column);
        params.set("filterOp", query.filter.op);
        if (query.filter.value !== undefined) params.set("filterValue", query.filter.value);
      }
      const qs = params.toString();
      return client.get<AppDataRowsPage>(
        `/v1/apps/${encodeURIComponent(appId)}/data/tables/${encodeURIComponent(table)}/rows${qs ? `?${qs}` : ""}`,
      );
    },

    async updateAppDataRow(appId, table, rowKey, patch) {
      const out = await client.patch<{ row: Record<string, unknown> }>(
        `/v1/apps/${encodeURIComponent(appId)}/data/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowKey)}`,
        { patch },
      );
      return out.row;
    },

    async deleteAppDataRow(appId, table, rowKey) {
      await client.delete<{ ok: true }>(
        `/v1/apps/${encodeURIComponent(appId)}/data/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowKey)}`,
      );
    },
  };
}
