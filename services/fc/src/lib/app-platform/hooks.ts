/**
 * What the app platform needs from whoever hosts an app's code.
 *
 * The platform builds, deploys and serves apps; it does not know where their
 * code lives or who may push to it. That is TeamClu's forge integration
 * (`src/lib/forge/`, Gitea today), which implements this interface and is
 * handed to the repository by the composition root. P1 of
 * docs/specs/2026-11-24-app-platform-infra-decoupling-design.md; plan in
 * 2026-11-25-app-platform-p1-gitea-out.md.
 *
 * Every method keeps the behaviour the inline Gitea code had: the same errors,
 * the same best-effort rules, the same response fields.
 *
 * Only what the platform itself calls is here. Who may push, and the
 * credentials that let them, are keyed by TeamClu's identities; those methods
 * are TeamClu's extension of this interface (`teamclu-apps/forge.ts`, P2.4b).
 */
import { ApiError } from "../http-utils.js";

/**
 * An app as a forge sees it: the app's own columns, and where its code lives
 * as the forge itself recorded it (`AppLifecycleHooks.repos`, attached by the
 * platform before it calls a hook). P3.3 of
 * docs/specs/2026-11-26-app-platform-p3-retire-legacy.md moved the repo off
 * the app row.
 */
export interface AppRepoRow {
  id: string;
  org_id?: string | null;
  /** The source revision of the last finalized deploy (`apps.deployed_revision`). */
  deployed_revision?: string | null;
  /** From the forge's record (`AppRepo.remoteUrl`). */
  git_remote_url?: string | null;
  /** From the forge's record (`AppRepo.authKind`). */
  git_auth_kind?: string | null;
}

/** Where an app's code lives, as the forge recorded it. */
export interface AppRepo {
  remoteUrl: string;
  /** How this deployment authenticates to it; null for an import with no credential. */
  authKind: string | null;
}

export interface AppRepoHead {
  sha: string;
  branch: string;
  deployedSha: string | null;
  /** null: unknown (nothing deployed yet, or not asked to compare). */
  undeployedCommits: number | null;
}

/** What a hook may need from the repository that calls it. */
export interface AppHookContext {
  /** A service-role client, for reads past RLS once the caller has been authorised. */
  serviceRoleClient(reason: string): Promise<any>;
}

export interface AppLifecycleHooks {
  // --- create ---
  /** Throws when a new app that needs a hosted repo cannot get one on this deployment. */
  assertCanHostRepo(): void;
  /** Create the app's repo and record it; returns what was recorded. */
  provisionRepo(app: AppRepoRow): Promise<{ remoteUrl: string; authKind: string }>;
  /** Record that the app's code lives at `remoteUrl`, a repo this deployment does not host (an import). */
  recordImportedRepo(appId: string, remoteUrl: string): Promise<void>;
  /**
   * Where each app's code lives, read with `client` — the caller's, for apps
   * it has just read, or the service role. Apps with no repo are absent.
   */
  repos(client: any, appIds: string[]): Promise<Map<string, AppRepo>>;
  /** The error a failed `provisionRepo` surfaces as, once the platform has recorded it. */
  provisionFailed(message: string, details: Record<string, unknown>): Error;

  // --- access (best-effort: a failure here never fails the change that caused it) ---
  /** Who can reach one app changed: a grant, its visibility, or it was just created. */
  appAccessChanged(appId: string): Promise<void>;

  // --- code access ---
  /** Whether this deployment hosts the app's repo and issues its credentials. */
  hostsRepo(app: AppRepoRow): boolean;
  /** The hosted repo's head; null for a repo this deployment does not host. */
  repoHead(app: AppRepoRow, opts: { compare: boolean }): Promise<AppRepoHead | null>;

  // --- deploy ---
  /**
   * Check a deploy's revision against the hosted repo, at each stage of the
   * deploy. Called only for an app this forge hosts (`hostsRepo`); throws an
   * ApiError to refuse. Every other app names its revision by content digest,
   * which the platform checks itself.
   */
  deployGuard(
    app: AppRepoRow,
    stage: "preflight" | "deploy" | "finalize",
    deploy: { revision: string; gitCommitSha?: string | null },
  ): Promise<void>;

  // --- credentials for a repo hosted elsewhere (an app imported over http(s)) ---
  /** Validate and keep the credential, and record the auth kind it returns. */
  storeExternalCredential(app: AppRepoRow, input: unknown): Promise<{ authKind: string }>;
  /** Stop naming it on the app's repo record, then forget it. */
  forgetExternalCredential(app: AppRepoRow): Promise<void>;

  // --- delete ---
  /** Retire the app's repo before its row goes. Best-effort; returns where the code now lives. */
  releaseRepo(app: AppRepoRow): Promise<{ archivedRepoUrl: string | null }>;

  // --- responses ---
  /** Extra fields for the app in `/v1/apps*` responses. */
  decorate(app: AppRepoRow): Record<string, unknown>;
}

export type AppLifecycleHooksFactory = (ctx: AppHookContext) => AppLifecycleHooks;

/** The fields `decorate` adds, for an app whose repo nobody hosts here. */
export const NO_FORGE_FIELDS = Object.freeze({ gitAccountAuth: false, gitHttpUrl: null });

/**
 * A deployment with no forge: imported and local apps work; an app that needs
 * a repo of ours cannot be created. Nothing records where an imported app's
 * code lives, so its `gitRemoteUrl` reads null.
 */
export function noForge(): AppLifecycleHooksFactory {
  return () => ({
    assertCanHostRepo() {
      throw new ApiError(503, "repo_hosting_unavailable", "this deployment hosts no app repositories");
    },
    async provisionRepo() {
      throw new ApiError(503, "repo_hosting_unavailable", "this deployment hosts no app repositories");
    },
    provisionFailed(message, details) {
      return new ApiError(502, "repo_provision_failed", message, { details });
    },
    async recordImportedRepo() {},
    async repos() { return new Map(); },
    async appAccessChanged() {},
    hostsRepo: () => false,
    async repoHead() { return null; },
    async deployGuard() {},
    async storeExternalCredential() {
      throw new ApiError(503, "repo_credentials_unavailable", "this deployment keeps no repository credentials");
    },
    async forgetExternalCredential() {},
    async releaseRepo(app) { return { archivedRepoUrl: app.git_remote_url ?? null }; },
    decorate: () => ({ ...NO_FORGE_FIELDS }),
  });
}

/** Background work a forge rides the app heartbeat for. Each returns fields for the tick's response body. */
export interface ForgeHeartbeat {
  /** Before the platform's own jobs, within `started + 8s`. */
  before?(client: any, started: number): Promise<Record<string, unknown>>;
  /** After them, in what is left of the window (`started + 50s`). */
  after?(client: any, started: number, now: Date): Promise<Record<string, unknown>>;
}
