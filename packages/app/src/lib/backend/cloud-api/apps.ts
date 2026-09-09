import type {
  AppsBackend,
  AppFilesPage,
  AppFilesQuery,
  AppStorageUsage,
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
} from "@/lib/backend/types";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";

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

    // --- File storage ---
    //
    // Paths travel base64url-encoded in the URL, matching the server: a file
    // path has slashes in it and a slash cannot survive one path segment.

    async listAppFiles(appId, query: AppFilesQuery = {}) {
      const params = new URLSearchParams();
      if (query.prefix) params.set("prefix", query.prefix);
      if (query.after) params.set("after", query.after);
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      try {
        return await client.get<AppFilesPage>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/objects${qs ? `?${qs}` : ""}`,
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async getAppStorageUsage(appId) {
      try {
        return await client.get<AppStorageUsage>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/usage`,
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async refreshAppStorageUsage(appId) {
      try {
        return await client.post<AppStorageUsage>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/usage/refresh`,
          {},
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async createAppFileUploadUrl(appId, input) {
      try {
        return await client.post<{ url: string; path: string; expiresIn: number }>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/sign-upload`,
          { path: input.path, contentType: input.contentType ?? null },
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async createAppFileDownloadUrl(appId, path) {
      try {
        return await client.get<{ url: string; size?: number; contentType?: string | null }>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/objects/${encodeFilePath(path)}/url`,
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async deleteAppFile(appId, path) {
      await client.delete<{ ok: true }>(
        `/v1/apps/${encodeURIComponent(appId)}/storage/objects/${encodeFilePath(path)}`,
      );
    },

    async purgeAppFiles(appId) {
      try {
        return await client.post<{ deleted: number }>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/purge`,
          {},
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async setAppStorageQuota(appId, quotaBytes) {
      try {
        return await client.put<{ quotaBytes: number | null }>(
          `/v1/apps/${encodeURIComponent(appId)}/storage/quota`,
          { quotaBytes },
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
  };
}

/**
 * base64url of a file path, for the one URL segment it has to fit in.
 *
 * `btoa` only takes latin1, and these paths are routinely Chinese, so the
 * string is UTF-8 encoded first - otherwise a filename with any non-ASCII
 * character throws before the request is ever made.
 */
function encodeFilePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
