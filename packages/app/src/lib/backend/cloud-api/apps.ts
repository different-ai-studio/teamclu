import type {
  AppsBackend,
  AppFilesPage,
  AppFilesQuery,
  AppStorageUsage,
  AppRow,
  AppDataRowsPage,
  AppDataRowsQuery,
  AppDataTable,
  AppLogEntry,
  AppLogsQuery,
  AppLogsResult,
  AppSessionRow,
  AppGitCredential,
  AppGitHead,
  AppMembership,
  AppMemberAccessRow,
  AppPermissionLevel,
  AppCustomDomain,
  AppCronJob,
  AppCronJobInput,
  AppCronRun,
  AppCronRunOutcome,
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
    async updateAppAuth(appId, patch) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, patch);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async setAppCustomDomain(appId, domain) {
      try {
        return await client.put<AppCustomDomain>(
          `/v1/apps/${encodeURIComponent(appId)}/custom-domain`,
          { domain },
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async verifyAppCustomDomain(appId) {
      try {
        const domain = await client.post<AppCustomDomain>(
          `/v1/apps/${encodeURIComponent(appId)}/custom-domain/verify`,
          {},
        );
        return { status: "verified", domain };
      } catch (e) {
        if (!(e instanceof CloudApiError)) throw e;
        if (e.status === 404) return { status: "not_found" };
        // 409 is "the record is not visible yet", which is ordinary while DNS
        // propagates. Surfacing it as a failure would tell the user something
        // is broken when the only thing to do is wait and press again.
        if (e.status === 409) return { status: "pending", message: e.message };
        throw e;
      }
    },

    async deleteAppCustomDomain(appId) {
      try {
        return await client.delete<AppCustomDomain>(
          `/v1/apps/${encodeURIComponent(appId)}/custom-domain`,
        );
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

    // --- Scheduled tasks (design 2026-09-10-app-control-panel §5) ---
    //
    // 404 → null throughout, the same convention the rest of this module uses:
    // the server answers 404 for "no such app" and for "not yours to see" alike,
    // so the client cannot tell them apart and must not pretend to.

    async listAppCronJobs(appId) {
      try {
        const page = await client.get<Page<AppCronJob>>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs`,
        );
        return page.items ?? [];
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async createAppCronJob(appId, input: AppCronJobInput) {
      try {
        return await client.post<AppCronJob>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs`,
          input,
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async updateAppCronJob(appId, jobId, input: AppCronJobInput) {
      try {
        return await client.patch<AppCronJob>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs/${encodeURIComponent(jobId)}`,
          input,
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async deleteAppCronJob(appId, jobId) {
      try {
        await client.delete<{ ok: true }>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs/${encodeURIComponent(jobId)}`,
        );
        return true;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return false;
        throw e;
      }
    },

    async runAppCronJobNow(appId, jobId) {
      try {
        return await client.post<AppCronRunOutcome>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs/${encodeURIComponent(jobId)}/run`,
          {},
        );
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async listAppCronRuns(appId, jobId, limit) {
      const qs = limit ? `?limit=${limit}` : "";
      try {
        const page = await client.get<Page<AppCronRun>>(
          `/v1/apps/${encodeURIComponent(appId)}/cron-jobs/${encodeURIComponent(jobId)}/runs${qs}`,
        );
        return page.items ?? [];
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },

    async readAppLogs(appId, query: AppLogsQuery = {}): Promise<AppLogsResult | null> {
      const params = new URLSearchParams();
      if (query.sinceMinutes) params.set("sinceMinutes", String(query.sinceMinutes));
      if (query.limit) params.set("limit", String(query.limit));
      if (query.kind) params.set("kind", query.kind);
      if (query.contains) params.set("contains", query.contains);
      if (query.requestId) params.set("requestId", query.requestId);
      const qs = params.toString();
      try {
        const page = await client.get<{
          items: AppLogEntry[];
          truncated: boolean;
          from?: string | null;
          to?: string | null;
        }>(`/v1/apps/${encodeURIComponent(appId)}/logs${qs ? `?${qs}` : ""}`);
        return {
          status: "ok",
          entries: page.items ?? [],
          truncated: page.truncated ?? false,
          from: page.from ?? null,
          to: page.to ?? null,
        };
      } catch (e) {
        if (!(e instanceof CloudApiError)) throw e;
        if (e.status === 404) return null;
        // Translated rather than thrown, as with listAppDataTables: each is a
        // state the view explains in its own sentence.
        if (e.code === "app_not_deployed") return { status: "not_deployed" };
        if (e.status === 503 || e.status === 502) {
          return { status: "unavailable", reason: e.message };
        }
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
