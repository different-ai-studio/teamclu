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

// ── Names derived from TeamClu ids ──────────────────────────────────────────
//
// Gitea mirrors TeamClu's identities rather than holding its own (spec
// docs/specs/2026-11-16-app-platform-identity-design.md §3): every name is
// computed from an immutable TeamClu id, so nothing maps one to the other and
// nothing can drift. 33 characters each — Gitea 1.22 caps a username at 40
// (verified 2026-11-16: 41 is rejected with `[Username]: MaxSize`).

const hex = (id: string) => id.replace(/-/g, "").toLowerCase();

/** The Gitea user of a TeamClu account (`auth.users.id`) — a person or an agent. */
export function giteaUserName(authUserId: string): string {
  return `u${hex(authUserId)}`;
}

/** The Gitea organisation of a TeamClu org (`public.orgs.id`). */
export function giteaOrgName(orgId: string): string {
  return `o${hex(orgId)}`;
}

/** The Gitea team that carries a TeamClu team's read access to its team-visible apps. */
export function giteaTeamName(teamId: string): string {
  return `t${hex(teamId)}`;
}

/** True for an owner this deployment created for a TeamClu org (`o<32 hex>`). */
export function isTeamCluOrgOwner(owner: string | null | undefined): boolean {
  return typeof owner === "string" && /^o[0-9a-f]{32}$/.test(owner);
}

/**
 * The repo owner named in an app's stored remote, or null when it cannot be
 * read. Handles every shape Gitea hands out or a person might paste:
 * `git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`,
 * `https://host/owner/repo.git`.
 */
export function repoOwnerFromRemote(remote: string | null | undefined): string | null {
  if (typeof remote !== "string") return null;
  const url = remote.trim();
  if (!url) return null;
  let path: string;
  const scp = /^[^\s:/@]+@[^\s:/]+:(?!\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    path = scp[1];
  } else {
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return decodeURIComponent(parts[parts.length - 2]);
}

/**
 * The HTTPS clone address for a repo whose stored remote is the SSH one Gitea
 * hands out. `publicBase` (GITEA_PUBLIC_URL) wins when given; otherwise the
 * SSH remote's host, which on both deploy targets also serves HTTPS through
 * the proxy (SSH is on a separate port).
 */
export function giteaHttpUrlFromRemote(remote: string | null | undefined, publicBase?: string | null): string | null {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const url = remote.trim();
  let host: string;
  let path: string;
  const scp = /^[^\s:/@]+@([^\s:/]+):(?!\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return `${parsed.origin}${parsed.pathname}`;
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }
  const clean = path.replace(/^\/+/, "");
  if (!host || clean.split("/").filter(Boolean).length < 2) return null;
  const repoPath = clean.endsWith(".git") ? clean : `${clean}.git`;
  const base = publicBase?.trim().replace(/\/+$/, "");
  if (base) {
    try {
      const parsed = new URL(base);
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}/${repoPath}`;
    } catch {
      // A malformed override falls back to the remote's own host.
    }
  }
  return `https://${host}/${repoPath}`;
}

/** Gitea's repository collaborator levels — the same words as TeamClu's app levels. */
export type GiteaCollaboratorPermission = "read" | "write" | "admin";

export type GiteaClientOptions = GiteaConfig & {
  fetch?: typeof fetch;
};

export function makeGiteaClient(opts: GiteaClientOptions) {
  const base = opts.url.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;
  const enc = encodeURIComponent;

  /** GET that answers null on 404 instead of throwing. */
  async function giteaGetOrNull(path: string): Promise<Response | null> {
    const res = await fetchFn(`${base}${path}`, {
      headers: { Authorization: `token ${opts.token}`, "Content-Type": "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(res.status >= 500 ? 502 : res.status, "gitea_error", detail || res.statusText || "gitea request failed");
    }
    return res;
  }

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
    /** The repo owner every per-app call below acts on. */
    owner: opts.owner,

    /**
     * The same client bound to another repo owner. Apps created before
     * per-org repos live under the configured `GITEA_OWNER`; newer ones live
     * under their TeamClu org's `o<uuid>` — see `repoOwnerFromRemote`.
     */
    withOwner(owner: string) {
      return owner === opts.owner ? this : makeGiteaClient({ ...opts, owner });
    },

    // ── Accounts, orgs and teams (admin token) ────────────────────────────

    /**
     * Make sure the Gitea user exists, and carries `fullName`.
     *
     * The address is a noreply one on purpose: a person's real email is
     * TeamClu's to show, not Gitea's, and the user never logs in with a
     * password (the gateway names them). The password is random and thrown
     * away.
     */
    async ensureUser(username: string, fullName: string): Promise<void> {
      const host = new URL(base).hostname || "gitea.local";
      const existing = await giteaGetOrNull(`/api/v1/users/${enc(username)}`);
      if (!existing) {
        const res = await fetchFn(`${base}/api/v1/admin/users`, {
          method: "POST",
          headers: { Authorization: `token ${opts.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            full_name: fullName,
            email: `${username}@users.noreply.${host}`,
            password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
            must_change_password: false,
            send_notify: false,
            visibility: "private",
          }),
        });
        // 422 "user already exists" is a race with another sync, not a failure.
        if (!res.ok && res.status !== 422) {
          const detail = await res.text().catch(() => "");
          throw new ApiError(res.status >= 500 ? 502 : res.status, "gitea_error", detail || "create user failed");
        }
        return;
      }
      const user = (await existing.json()) as { full_name?: string };
      if ((user.full_name ?? "") !== fullName) {
        await giteaFetch(`/api/v1/admin/users/${enc(username)}`, {
          method: "PATCH",
          body: JSON.stringify({ full_name: fullName, login_name: username, source_id: 0 }),
        });
      }
    },

    /** Make sure the org exists (private, owned by this deployment's bot). */
    async ensureOrg(org: string): Promise<void> {
      if (await giteaGetOrNull(`/api/v1/orgs/${enc(org)}`)) return;
      const res = await fetchFn(`${base}/api/v1/orgs`, {
        method: "POST",
        headers: { Authorization: `token ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: org, visibility: "private", repo_admin_change_team_access: false }),
      });
      if (!res.ok && res.status !== 422) {
        const detail = await res.text().catch(() => "");
        throw new ApiError(res.status >= 500 ? 502 : res.status, "gitea_error", detail || "create org failed");
      }
    },

    /**
     * The id of the org's read-only team `name`, created on first use. It
     * carries one TeamClu team's read access to its team-visible apps, so it
     * covers code and pull requests and nothing else, on no repo by default.
     */
    async ensureReadTeam(org: string, name: string): Promise<number> {
      const found = await this.findTeamId(org, name);
      if (found !== null) return found;
      const res = await giteaFetch(`/api/v1/orgs/${enc(org)}/teams`, {
        method: "POST",
        body: JSON.stringify({
          name,
          permission: "read",
          units: ["repo.code", "repo.pulls"],
          includes_all_repositories: false,
          can_create_org_repo: false,
        }),
      });
      const created = (await res.json()) as { id?: number };
      if (!Number.isInteger(created.id)) throw new ApiError(502, "gitea_error", "create team returned no id");
      return created.id!;
    },

    /** The id of the org's team `name`, or null when the org or the team does not exist. */
    async findTeamId(org: string, name: string): Promise<number | null> {
      const listRes = await giteaGetOrNull(`/api/v1/orgs/${enc(org)}/teams?limit=50`);
      if (!listRes) return null;
      const teams = (await listRes.json()) as { id: number; name: string }[];
      const found = Array.isArray(teams) ? teams.find((t) => t.name === name) : undefined;
      return found ? found.id : null;
    },

    async listTeamMembers(teamId: number): Promise<string[]> {
      const res = await giteaFetch(`/api/v1/teams/${teamId}/members?limit=50`);
      const users = (await res.json()) as { login?: string }[];
      return Array.isArray(users) ? users.map((u) => String(u.login ?? "")).filter(Boolean) : [];
    },

    async addTeamMember(teamId: number, username: string): Promise<void> {
      await giteaFetch(`/api/v1/teams/${teamId}/members/${enc(username)}`, { method: "PUT" });
    },

    async removeTeamMember(teamId: number, username: string): Promise<void> {
      await giteaFetch(`/api/v1/teams/${teamId}/members/${enc(username)}`, { method: "DELETE" });
    },

    async setTeamRepo(teamId: number, appId: string, present: boolean): Promise<void> {
      const path = `/api/v1/teams/${teamId}/repos/${enc(opts.owner)}/${enc(appRepoName(appId))}`;
      if (present) {
        await giteaFetch(path, { method: "PUT" });
        return;
      }
      const res = await fetchFn(`${base}${path}`, {
        method: "DELETE",
        headers: { Authorization: `token ${opts.token}` },
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new ApiError(res.status >= 500 ? 502 : res.status, "gitea_error", detail || "remove team repo failed");
      }
    },

    // ── Collaborators on the app's repo ───────────────────────────────────

    /**
     * Direct collaborators and their level.
     *
     * The list endpoint carries no level (verified on 1.22.6), so each one is
     * asked separately. That answer is the EFFECTIVE level — direct grant or
     * team, whichever is higher — which is exact here: the only team on an
     * app repo grants `read`, and a direct grant is never below that.
     */
    async listCollaborators(appId: string): Promise<{ username: string; permission: GiteaCollaboratorPermission }[]> {
      const repoPath = `/api/v1/repos/${enc(opts.owner)}/${enc(appRepoName(appId))}`;
      const res = await giteaFetch(`${repoPath}/collaborators?limit=50`);
      const users = (await res.json()) as { login?: string }[];
      if (!Array.isArray(users)) return [];
      const out: { username: string; permission: GiteaCollaboratorPermission }[] = [];
      for (const u of users) {
        const username = String(u.login ?? "");
        if (!username) continue;
        const permRes = await giteaFetch(`${repoPath}/collaborators/${enc(username)}/permission`);
        const perm = ((await permRes.json()) as { permission?: string }).permission;
        out.push({ username, permission: perm === "admin" || perm === "owner" ? "admin" : perm === "write" ? "write" : "read" });
      }
      return out;
    },

    async setCollaborator(appId: string, username: string, permission: GiteaCollaboratorPermission): Promise<void> {
      await giteaFetch(
        `/api/v1/repos/${enc(opts.owner)}/${enc(appRepoName(appId))}/collaborators/${enc(username)}`,
        { method: "PUT", body: JSON.stringify({ permission }) },
      );
    },

    async removeCollaborator(appId: string, username: string): Promise<void> {
      const res = await fetchFn(
        `${base}/api/v1/repos/${enc(opts.owner)}/${enc(appRepoName(appId))}/collaborators/${enc(username)}`,
        { method: "DELETE", headers: { Authorization: `token ${opts.token}` } },
      );
      if (!res.ok && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new ApiError(res.status >= 500 ? 502 : res.status, "gitea_error", detail || "remove collaborator failed");
      }
    },

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

    /**
     * Register a deploy key on the app repo. Write access unless `readOnly`: a
     * key handed out only so someone can download the code must not also be
     * able to push to it.
     */
    async createDeployKey(
      appId: string,
      title: string,
      key: string,
      { readOnly = false }: { readOnly?: boolean } = {},
    ): Promise<{ id: number }> {
      const repo = appRepoName(appId);
      const res = await giteaFetch(
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}/keys`,
        {
          method: "POST",
          body: JSON.stringify({ title, key, read_only: readOnly }),
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

    /**
     * Default-branch HEAD commit on the app repo (bot token).
     *
     * The branch NAME comes back too, at no cost: resolving the head already
     * requires asking the repo which branch is default, and a panel that says
     * "3 commits behind" is much easier to act on when it also says behind
     * what.
     */
    async getRepoHead(appId: string): Promise<{ sha: string; branch: string }> {
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
      return { sha, branch };
    },

    /**
     * How many commits `head` has that `base` does not.
     *
     * Null rather than an error whenever the question cannot be answered: the
     * base commit may have been force-pushed away or garbage-collected, the two
     * may have unrelated histories, or an older Gitea may not serve /compare at
     * all. All of those mean "we cannot say how far behind this is", and none of
     * them is a reason to fail the panel row that merely wanted a number next to
     * two commit ids it already has.
     */
    async compareCommits(appId: string, base: string, head: string): Promise<number | null> {
      const repo = appRepoName(appId);
      const path =
        `/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(repo)}` +
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      try {
        const res = await giteaFetch(path);
        const data = (await res.json()) as { total_commits?: number };
        const total = data.total_commits;
        return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
      } catch {
        return null;
      }
    },
  };
}

export type GiteaClient = ReturnType<typeof makeGiteaClient>;
