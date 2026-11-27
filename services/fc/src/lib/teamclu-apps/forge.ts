/**
 * TeamClu's forge: the platform's lifecycle hooks plus what only TeamClu calls.
 *
 * The app platform drives a forge through `AppLifecycleHooks`
 * (app-platform/hooks.ts) and never names a team or an actor. TeamClu also
 * re-syncs repo access when a team's membership changes, narrows a member's
 * push rights, and issues git credentials to actors; those take TeamClu's ids
 * and live here (P2.4b of docs/specs/2026-11-25-app-platform-p2-de-team.md).
 */
import { noForge, type AppHookContext, type AppLifecycleHooks, type AppRepoRow } from "../app-platform/hooks.js";
import { readForgeRepos, writeForgeRepo } from "./forge-repos.js";

export interface TeamCluForge extends AppLifecycleHooks {
  /** Who is in a team changed, so every team-visible app of it changed too. */
  teamAccessChanged(teamId: string): Promise<void>;
  /** A member lost the right to push to an app (removed, or narrowed to read). */
  memberWriteRevoked(appId: string, memberId: string): Promise<void>;
  /** A credential for `actorId` to clone (and unless `readOnly`, push) a hosted repo; null if none applies. */
  issueCredential(app: AppRepoRow, actorId: string, opts: { readOnly: boolean }): Promise<Record<string, unknown> | null>;
  /** Hand back a credential `issueCredential` gave `actorId`. False when it was already gone. */
  revokeCredential(app: AppRepoRow, actorId: string, credentialId: number): Promise<boolean>;
}

export type TeamCluForgeFactory = (ctx: AppHookContext) => TeamCluForge;

/**
 * Where apps' code lives, kept in TeamClu's `app_forge_repos` whether or not
 * this deployment hosts any repo: an imported app is recorded the same way.
 */
export function forgeRepoRecords(ctx: AppHookContext): Pick<AppLifecycleHooks, "repos" | "recordImportedRepo"> {
  return {
    repos: (client, appIds) => readForgeRepos(client, appIds),
    async recordImportedRepo(appId, remoteUrl) {
      const admin = await ctx.serviceRoleClient("record an imported app's repo");
      await writeForgeRepo(admin, appId, { remoteUrl, authKind: null });
    },
  };
}

/** No forge: the platform's `noForge` plus TeamClu's repo records, and nothing to sync or issue. */
export function noTeamCluForge(): TeamCluForgeFactory {
  const base = noForge();
  return (ctx) => ({
    ...base(ctx),
    ...forgeRepoRecords(ctx),
    async teamAccessChanged() {},
    async memberWriteRevoked() {},
    async issueCredential() { return null; },
    async revokeCredential() { return false; },
  });
}
