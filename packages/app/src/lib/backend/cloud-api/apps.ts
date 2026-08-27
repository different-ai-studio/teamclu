import type {
  AppsBackend,
  AppRow,
  AppSessionRow,
  AppGitCredential,
  AppGitHead,
  AppMembership,
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
  };
}
