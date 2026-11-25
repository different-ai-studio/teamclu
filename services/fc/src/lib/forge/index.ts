/**
 * TeamClu's forge integration: the app platform's `AppLifecycleHooks`,
 * implemented on the deployment's Gitea.
 *
 * Everything here used to be written inline in the repository (createApp,
 * the access methods, git credentials, delete, the heartbeat). It moved
 * behind the hooks unchanged — same calls, same errors, same best-effort
 * rules. P1.2 of docs/specs/2026-11-25-app-platform-p1-gitea-out.md.
 */
import type {
  AppLifecycleHooks,
  AppLifecycleHooksFactory,
  AppRepoRow,
  ForgeHeartbeat,
} from "../app-platform/hooks.js";
import { ApiError } from "../http-utils.js";
import {
  GITEA_AUTH_KIND,
  giteaHttpUrlFromRemote,
  giteaOrgName,
  giteaUnavailable,
  isTeamCluOrgOwner,
  makeGiteaClient,
  readGiteaConfig,
  repoOwnerFromRemote,
  type GiteaClient,
} from "./gitea/client.js";
import {
  issueJitDeployKey,
  revokeActorDeployKeys,
  revokeAllDeployKeys,
  revokeOwnJitDeployKey,
} from "./gitea/deploy-key.js";
import { makeDeployKeyExpirySweep } from "./gitea/deploy-key-expiry.js";
import { reconcileGiteaApps } from "./gitea/sync.js";
import { giteaAccountAuthEnabled, makeGiteaSyncRunner } from "./gitea/sync-runner.js";
import {
  APP_GIT_HTTPS_CREDENTIAL_KIND,
  deserializeGitHttpsCredential,
  GIT_HTTPS_AUTH_KIND,
  isHttpGitRemote,
  serializeGitHttpsCredential,
  type GitHttpsCredential,
} from "./imported-http.js";
import {
  deleteAppSecretSupabase,
  getAppSecretSupabase,
  putAppSecretSupabase,
} from "../provisioning/app-secrets.js";

export interface GiteaForgeOptions {
  /** Absent when GITEA_URL / GITEA_TOKEN / GITEA_OWNER are not all set. */
  gitea?: GiteaClient | null;
  /** The variable that left `gitea` absent, for the 503. */
  unavailableReason?: string;
  /** GITEA_ACCOUNT_AUTH: repos under the TeamClu org, access mirrored to Gitea. */
  accountAuth?: boolean;
  /** Tests shorten how long a team re-sync is waited for. */
  teamSyncWaitMs?: number;
}

/**
 * Per-account fields of an app (GITEA_ACCOUNT_AUTH): a new client points the
 * checkout at `gitHttpUrl` and authenticates with its own account. The stored
 * remote and auth kind stay as they were so older daemons keep working over
 * SSH + deploy keys.
 */
export function giteaAccountFields(app: AppRepoRow): { gitAccountAuth: boolean; gitHttpUrl: string | null } {
  const accountAuth =
    app.git_auth_kind === GITEA_AUTH_KIND &&
    giteaAccountAuthEnabled() &&
    isTeamCluOrgOwner(repoOwnerFromRemote(app.git_remote_url));
  return {
    gitAccountAuth: accountAuth,
    gitHttpUrl: accountAuth ? giteaHttpUrlFromRemote(app.git_remote_url, process.env.GITEA_PUBLIC_URL) : null,
  };
}

export function makeGiteaForge(opts: GiteaForgeOptions): AppLifecycleHooksFactory {
  const { gitea, unavailableReason } = opts;
  const accountAuth = opts.accountAuth ?? giteaAccountAuthEnabled();
  return (ctx) => {
    const sync = makeGiteaSyncRunner({
      gitea,
      enabled: accountAuth,
      serviceRoleClient: ctx.serviceRoleClient,
      teamWaitMs: opts.teamSyncWaitMs,
    });

    const hostsRepo = (app: AppRepoRow) => app.git_auth_kind === GITEA_AUTH_KIND;

    /**
     * The Gitea client bound to the owner an app's repo actually lives under:
     * `GITEA_OWNER` for apps created before per-org repos, the TeamClu org's
     * `o<uuid>` for newer ones. Read from the stored remote, so no column says it.
     */
    function repoClient(app: AppRepoRow): GiteaClient {
      if (!gitea) throw giteaUnavailable(unavailableReason);
      return gitea.withOwner(repoOwnerFromRemote(app.git_remote_url) ?? gitea.owner);
    }

    const hooks: AppLifecycleHooks = {
      assertCanHostRepo() {
        if (!gitea) throw giteaUnavailable(unavailableReason);
      },

      async provisionRepo(app) {
        // The SSH URL, not `clone_url`: the deploy key is the only credential
        // we hand out for this repo, and it is useless over HTTPS.
        // Per-org repos (GITEA_ACCOUNT_AUTH): the repo lives under the app's
        // TeamClu org, so Gitea's org is TeamClu's. Otherwise the shared owner.
        if (!gitea) throw giteaUnavailable(unavailableReason);
        let repoGitea = gitea;
        if (accountAuth && app.org_id) {
          const owner = giteaOrgName(app.org_id);
          await gitea.ensureOrg(owner);
          repoGitea = gitea.withOwner(owner);
        }
        const { sshUrl } = await repoGitea.createAppRepo(app.id);
        return { remoteUrl: sshUrl, authKind: GITEA_AUTH_KIND };
      },

      provisionFailed(message, details) {
        // `details`, not a bare 4th-argument object — ApiError reads only
        // `options.details` / `options.cause`, so the errored row was dropped.
        return new ApiError(502, "gitea_provision_failed", message, { details });
      },

      appAccessChanged: (appId) => sync.app(appId),
      teamAccessChanged: (teamId) => sync.team(teamId),

      /**
       * Revoke JIT deploy keys when access is removed or downgraded to view-only.
       *
       * Best-effort throughout, like the `revokeActorDeployKeys` it wraps. This
       * runs *after* the grant row is already gone, so throwing here reported a
       * completed revoke as a 500 — the caller then retries against a grant that
       * no longer exists. A deployment with no service-role key, or a transient
       * PostgREST error, must not turn "access removed" into "request failed".
       * The keys that survive are still bounded by the expiry sweep.
       */
      async memberWriteRevoked(appId, memberId) {
        if (!gitea) return;
        try {
          const admin = await ctx.serviceRoleClient("revoke deploy keys on deauth");
          const { data: app, error } = await admin
            .from("apps")
            .select("id, git_auth_kind, git_remote_url")
            .eq("id", appId)
            .maybeSingle();
          if (error) throw error;
          if (!app || !hostsRepo(app)) return;
          await revokeActorDeployKeys(repoClient(app), appId, memberId);
        } catch (e) {
          console.warn("[apps] deploy key revoke failed after deauth (non-fatal)", e);
        }
      },

      hostsRepo,

      /**
       * The credential for whoever may clone the app's repo:
       *
       * - an app imported from an http(s) repo with a stored token: that token,
       *   for exactly the callers a Gitea app's deploy key goes to — the machines
       *   that clone the repo and the agents that pull it;
       * - a Gitea-managed app: a JIT deploy key titled for `actorId`, `readOnly`
       *   for a caller who may download the code but not push to it.
       */
      async issueCredential(app, actorId, { readOnly }) {
        if (app.git_auth_kind === GIT_HTTPS_AUTH_KIND) {
          if (!isHttpGitRemote(app.git_remote_url)) return null;
          const admin = await ctx.serviceRoleClient("read app git credential");
          const plaintext = await getAppSecretSupabase(admin, app.id, APP_GIT_HTTPS_CREDENTIAL_KIND);
          const credential = plaintext ? deserializeGitHttpsCredential(plaintext) : null;
          if (!credential) return null;
          return {
            remoteUrl: app.git_remote_url as string,
            authKind: GIT_HTTPS_AUTH_KIND,
            username: credential.username,
            token: credential.token,
          };
        }
        if (!app.git_remote_url) return null;
        // An imported app has a remote this deployment holds no credential for;
        // minting a Gitea key for it would 404 on a repo that does not exist.
        if (!hostsRepo(app)) return null;
        if (!gitea) throw giteaUnavailable(unavailableReason);
        const jit = await issueJitDeployKey(repoClient(app), app.id, actorId, Date.now(), { readOnly });
        return {
          remoteUrl: app.git_remote_url,
          authKind: "deploy_key" as const,
          ...jit,
          // Per-account auth: the daemon keeps using this deploy key over SSH for
          // its own seed/fetch, and points the checkout's people and agents at
          // gitHttpUrl (spec §6). Absent → the checkout stays on SSH as before.
          ...giteaAccountFields(app),
        };
      },

      async revokeCredential(app, actorId, credentialId) {
        if (!gitea) throw giteaUnavailable(unavailableReason);
        return revokeOwnJitDeployKey(repoClient(app), app.id, actorId, credentialId);
      },

      async repoHead(app, { compare }) {
        // An imported app's repo is somebody else's and we hold no credential for
        // it, so there is no head to read. Null, not an error: "we cannot see the
        // branch" is a legitimate state for such an app, permanently.
        if (!hostsRepo(app)) return null;
        if (!gitea) throw giteaUnavailable(unavailableReason);
        const repoGitea = repoClient(app);
        const head = await repoGitea.getRepoHead(app.id);
        const deployedSha = app.git_commit_sha ?? null;
        if (!compare) return { ...head, deployedSha, undeployedCommits: null };

        // Three cases, and only the last one costs a request:
        //   nothing deployed  → unknown, not zero (there is no baseline)
        //   already on head   → zero, known without asking
        //   otherwise         → ask the forge
        let undeployedCommits: number | null = null;
        if (deployedSha === head.sha) {
          undeployedCommits = 0;
        } else if (deployedSha) {
          undeployedCommits = await repoGitea.compareCommits(app.id, deployedSha, head.sha);
        }
        return { ...head, deployedSha, undeployedCommits };
      },

      async deployGuard(app, stage, { revision, gitCommitSha }) {
        // A Gitea-managed app deploys a commit of its repo, and only the one at
        // the branch head: what is live is always something the repo holds.
        // The daemon checks the same before it asks (crates/teamclu-apps
        // deploy.rs); this is the server side of it, for every caller.
        if (stage === "finalize") {
          if (gitCommitSha !== revision) {
            throw new ApiError(409, "revision_mismatch", "built SHA differs from preflight revision");
          }
          return;
        }
        const head = await hooks.repoHead(app, { compare: false });
        if (!head || head.sha !== revision || gitCommitSha !== revision) {
          throw new ApiError(
            409,
            "revision_mismatch",
            stage === "preflight"
              ? "Gitea deploy requires the clean checkout at exact remote HEAD"
              : "Gitea HEAD changed after preflight",
          );
        }
      },

      /**
       * Keep the token for an imported app's http(s) repo. The secret is
       * written before the platform's row names it, and deleted only after the
       * row stops naming it, so a row that says `https_token` always has a
       * secret behind it.
       */
      async storeExternalCredential(app, input) {
        if (!isHttpGitRemote(app.git_remote_url)) {
          throw new ApiError(
            400,
            "validation_failed",
            "a stored credential only applies to an app imported from an http(s) repo address",
          );
        }
        const admin = await ctx.serviceRoleClient("store app git credential");
        await putAppSecretSupabase(
          admin,
          app.id,
          APP_GIT_HTTPS_CREDENTIAL_KIND,
          serializeGitHttpsCredential(input as GitHttpsCredential),
        );
        return { authKind: GIT_HTTPS_AUTH_KIND };
      },

      async forgetExternalCredential(app) {
        const admin = await ctx.serviceRoleClient("clear app git credential");
        await deleteAppSecretSupabase(admin, app.id, APP_GIT_HTTPS_CREDENTIAL_KIND);
      },

      async releaseRepo(app) {
        let archivedRepoUrl: string | null = app.git_remote_url ?? null;
        if (!hostsRepo(app) || !gitea) return { archivedRepoUrl };
        const repoGitea = repoClient(app);
        // Before the rename: the calls below address the repo by its app name.
        // Own try — a failure here must not leave the repo unarchived as well.
        try {
          await repoGitea.removeAllAppAccess?.(app.id);
        } catch {
          // Best effort, like the keys.
        }
        try {
          await revokeAllDeployKeys(repoGitea, app.id);
          const patched = await repoGitea.archiveAndRenameAppRepo(app.id);
          archivedRepoUrl = patched.sshUrl ?? archivedRepoUrl;
        } catch {
          // Gitea failure must not block the DB delete; ops can reconcile manually.
        }
        return { archivedRepoUrl };
      },

      decorate: giteaAccountFields,
    };
    return hooks;
  };
}

/** The forge for this deployment, from GITEA_* in the environment. */
export function forgeFromEnv(env: NodeJS.ProcessEnv = process.env): AppLifecycleHooksFactory {
  const resolved = readGiteaConfig(env);
  return resolved.error
    ? makeGiteaForge({ unavailableReason: resolved.error })
    : makeGiteaForge({ gitea: makeGiteaClient(resolved.config) });
}

/** Every tenth minute: often enough that a failed request-path sync heals quickly, rarely enough to stay cheap. */
export function isGiteaReconcileMinute(now: Date): boolean {
  return now.getUTCMinutes() % 10 === 0;
}

export interface ForgeHeartbeatOptions {
  /** Expired-JIT-key sweep; absent with no Gitea configured. */
  deployKeySweep?: ((client: any, deadline: number) => Promise<any>) | null;
  /** Repair pass; absent when GITEA_ACCOUNT_AUTH is off or no Gitea is configured. */
  reconcile?: ((client: any, deadline: number) => Promise<unknown>) | null;
}

/**
 * What the forge does on the app heartbeat: sweep expired deploy keys first,
 * then — every tenth minute, in what is left of the window — repair the Gitea
 * mirror of app access. Response fields `deployKeys` and `gitea`, as before.
 */
export function makeForgeHeartbeat(opts: ForgeHeartbeatOptions): ForgeHeartbeat {
  const { deployKeySweep, reconcile } = opts;
  return {
    async before(client, started) {
      if (!deployKeySweep) return {};
      try {
        const result = await deployKeySweep(client, started + 8_000);
        if (result.failed) console.warn("[gitea] deploy key sweep failures:", result.failed);
        return { deployKeys: result };
      } catch {
        console.warn("[gitea] deploy key sweep failed");
        return { deployKeys: { error: "deploy key sweep failed" } };
      }
    },
    async after(client, started, now) {
      if (!reconcile || !isGiteaReconcileMinute(now)) return {};
      try {
        return { gitea: await reconcile(client, started + 50_000) };
      } catch (e) {
        return { gitea: { error: String((e as Error)?.message ?? e) } };
      }
    },
  };
}

/** The heartbeat work for this deployment's Gitea, from the environment. */
export function forgeHeartbeatFromEnv(env: NodeJS.ProcessEnv = process.env): ForgeHeartbeat | null {
  const resolved = readGiteaConfig(env);
  if (resolved.error) return null;
  const gitea = makeGiteaClient(resolved.config);
  return makeForgeHeartbeat({
    deployKeySweep: makeDeployKeyExpirySweep({ gitea }),
    reconcile: giteaAccountAuthEnabled(env)
      ? (admin, deadline) => reconcileGiteaApps({ gitea, admin, log: (m) => console.warn(m) }, { deadline })
      : null,
  });
}
