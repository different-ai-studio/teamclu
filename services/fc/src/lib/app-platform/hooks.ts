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
 */
import { ApiError } from "../http-utils.js";

/** The app columns a forge reads. Still on `amux.apps` until P1.5 moves them. */
export interface AppRepoRow {
  id: string;
  org_id?: string | null;
  git_remote_url?: string | null;
  git_auth_kind?: string | null;
  git_commit_sha?: string | null;
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
  /** Create the app's repo; the platform stores what comes back on the app row. */
  provisionRepo(app: AppRepoRow): Promise<{ remoteUrl: string; authKind: string }>;
  /** The error a failed `provisionRepo` surfaces as, once the platform has recorded it. */
  provisionFailed(message: string, details: Record<string, unknown>): Error;

  // --- access (best-effort: a failure here never fails the change that caused it) ---
  /** Who can reach one app changed: a grant, its visibility, or it was just created. */
  appAccessChanged(appId: string): Promise<void>;
  /** Who is in a team changed, so every team-visible app of it changed too. */
  teamAccessChanged(teamId: string): Promise<void>;
  /** A member lost the right to push to an app (removed, or narrowed to read). */
  memberWriteRevoked(appId: string, memberId: string): Promise<void>;

  // --- code access ---
  /** Whether this deployment hosts the app's repo and issues its credentials. */
  hostsRepo(app: AppRepoRow): boolean;
  /** A credential for `actorId` to clone (and unless `readOnly`, push) a hosted repo; null if none applies. */
  issueCredential(app: AppRepoRow, actorId: string, opts: { readOnly: boolean }): Promise<Record<string, unknown> | null>;
  /** Hand back a credential `issueCredential` gave `actorId`. False when it was already gone. */
  revokeCredential(app: AppRepoRow, actorId: string, credentialId: number): Promise<boolean>;
  /** The hosted repo's head; null for a repo this deployment does not host. */
  repoHead(app: AppRepoRow, opts: { compare: boolean }): Promise<AppRepoHead | null>;

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
 * a repo of ours cannot be created.
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
    async appAccessChanged() {},
    async teamAccessChanged() {},
    async memberWriteRevoked() {},
    hostsRepo: () => false,
    async issueCredential() { return null; },
    async revokeCredential() { return false; },
    async repoHead() { return null; },
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
