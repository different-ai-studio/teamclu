import { ApiError } from "../http-utils.js";

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

export interface GiteaConfig {
  url: string;
  token: string;
  owner: string;
}

export type GiteaConfigResolution =
  | { config: GiteaConfig; error?: undefined }
  | { config?: undefined; error: string };

/**
 * 503 for an apps call that needs Gitea but the deployment has not configured it.
 *
 * `reason` names the empty variable (GITEA_URL / GITEA_TOKEN / GITEA_OWNER)
 * so the operator sees which knob to turn instead of a bare "not configured".
 */
export function giteaUnavailable(reason?: string): ApiError {
  return new ApiError(
    503,
    "gitea_unavailable",
    reason ? `gitea not configured: ${reason}` : "gitea not configured",
  );
}

/** Read Gitea bot credentials. Returns the first missing/empty variable by name. */
export function readGiteaConfig(env: Env = process.env): GiteaConfigResolution {
  const url = trimmed(env.GITEA_URL).replace(/\/+$/, "");
  if (!url) return { error: "GITEA_URL is empty" };
  const token = trimmed(env.GITEA_TOKEN);
  if (!token) return { error: "GITEA_TOKEN is empty" };
  const owner = trimmed(env.GITEA_OWNER);
  if (!owner) return { error: "GITEA_OWNER is empty" };
  return { config: { url, token, owner } };
}

export function appRepoName(appId: string): string {
  return `tc-app-${appId}`;
}

/** Archived repos are renamed so ops can tell deleted apps apart in Gitea. */
export function deletedAppRepoName(appId: string): string {
  return `deleted-${appRepoName(appId)}`;
}

/**
 * `apps.git_auth_kind` for a repo this deployment provisioned on Gitea and
 * holds a deploy key for. Null means the app was imported from a remote we
 * have no credential for — its deploys build the workdir as it sits.
 */
export const GITEA_AUTH_KIND = "gitea_deploy_key";

export type GiteaClientOptions = GiteaConfig & {
  fetch?: typeof fetch;
};

export function makeGiteaClient(opts: GiteaClientOptions) {
  const base = opts.url.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;

  async function giteaFetch(path: string, init: RequestInit = {}) {
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `token ${opts.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(
        res.status >= 500 ? 502 : res.status,
        "gitea_error",
        detail || res.statusText || "gitea request failed",
      );
    }
    return res;
  }

  return {
    /**
     * Create the app's private repo and report both of its URLs.
     *
     * `sshUrl` is the one to persist as the app's remote: the only credential
     * this service ever issues for it is an SSH deploy key, so storing the
     * HTTPS `clone_url` left every seed push and deploy fetch asking for a
     * username it has no way to supply.
     */
    async createAppRepo(appId: string): Promise<{ cloneUrl: string; sshUrl: string }> {
      const name = appRepoName(appId);
      const res = await giteaFetch(`/api/v1/orgs/${encodeURIComponent(opts.owner)}/repos`, {
        method: "POST",
        body: JSON.stringify({ name, private: true }),
      });
      const data = (await res.json()) as { clone_url?: string; ssh_url?: string };
      if (!data.clone_url) {
        throw new ApiError(502, "gitea_error", "create repo returned no clone_url");
      }
      if (!data.ssh_url) {
        throw new ApiError(502, "gitea_error", "create repo returned no ssh_url");
      }
      return { cloneUrl: data.clone_url, sshUrl: data.ssh_url };
    },

    async createDeployKey(appId: string, title: string, key: string): Promise<{ id: number }> {
      const repo = appRepoName(appId);
      const res = await giteaFetch(
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}/keys`,
        {
          method: "POST",
          body: JSON.stringify({ title, key, read_only: false }),
        },
      );
      const data = (await res.json()) as { id?: number };
      if (!Number.isInteger(data.id)) {
        throw new ApiError(502, "gitea_error", "create deploy key returned no id");
      }
      return { id: data.id! };
    },

    /** Deploy keys currently registered on the app's repo. */
    async listDeployKeys(appId: string): Promise<{ id: number; title: string }[]> {
      const repo = appRepoName(appId);
      const res = await giteaFetch(
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}/keys`,
      );
      const data = (await res.json()) as { id?: number; title?: string }[];
      if (!Array.isArray(data)) return [];
      return data
        .filter((k) => Number.isInteger(k.id))
        .map((k) => ({ id: k.id!, title: String(k.title ?? "") }));
    },

    async deleteDeployKey(appId: string, keyId: number): Promise<void> {
      const repo = appRepoName(appId);
      await giteaFetch(
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}/keys/${keyId}`,
        { method: "DELETE" },
      );
    },

    /** Revoke write access and mark the repo read-only with a deleted- prefix (§7.2). */
    async archiveAndRenameAppRepo(appId: string): Promise<{ sshUrl: string | null }> {
      const repo = appRepoName(appId);
      const res = await giteaFetch(
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            archived: true,
            name: deletedAppRepoName(appId),
          }),
        },
      );
      const data = (await res.json()) as { ssh_url?: string; clone_url?: string };
      return { sshUrl: data.ssh_url?.trim() || data.clone_url?.trim() || null };
    },

    /** Default-branch HEAD commit on the app repo (bot token). */
    async getRepoHead(appId: string): Promise<{ sha: string }> {
      const repo = appRepoName(appId);
      const repoPath = `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}`;
      const repoRes = await giteaFetch(repoPath);
      const repoData = (await repoRes.json()) as { default_branch?: string };
      const branch = repoData.default_branch?.trim();
      if (!branch) {
        throw new ApiError(502, "gitea_error", "repo returned no default_branch");
      }
      const branchRes = await giteaFetch(`${repoPath}/branches/${encodeURIComponent(branch)}`);
      const branchData = (await branchRes.json()) as { commit?: { id?: string } };
      const sha = branchData.commit?.id?.trim();
      if (!sha) {
        throw new ApiError(502, "gitea_error", "branch returned no commit id");
      }
      return { sha };
    },
  };
}

export type GiteaClient = ReturnType<typeof makeGiteaClient>;
