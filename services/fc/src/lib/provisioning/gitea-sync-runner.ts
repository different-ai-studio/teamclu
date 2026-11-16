import type { GiteaClient } from "./gitea.js";
import { syncAppToGitea, syncTeamAppsToGitea } from "./gitea-sync.js";

type Env = NodeJS.ProcessEnv;

/**
 * `GITEA_ACCOUNT_AUTH=on` turns on per-account Gitea auth: new apps get their
 * repo under the TeamClu org, access is mirrored to Gitea, and clients are
 * told to use HTTPS. Off (the default, and belayo's setting) changes nothing.
 */
export function giteaAccountAuthEnabled(env: Env = process.env): boolean {
  return (env.GITEA_ACCOUNT_AUTH ?? "").trim().toLowerCase() === "on";
}

export interface GiteaSyncRunner {
  /** Re-sync one app. Never throws: the business change already happened. */
  app(appId: string): Promise<void>;
  /** Re-sync every managed app of a team (someone joined or left it). */
  team(teamId: string): Promise<void>;
}

const NOOP: GiteaSyncRunner = { app: async () => {}, team: async () => {} };

/**
 * The request paths' handle on the sync. Best-effort by design: a Gitea that
 * is down must not turn "access granted" into a 500, and whatever a failed
 * call leaves behind is repaired by the reconcile timer.
 */
export function makeGiteaSyncRunner(opts: {
  gitea?: GiteaClient | null;
  enabled: boolean;
  serviceRoleClient: (why: string) => Promise<any>;
  log?: (message: string) => void;
}): GiteaSyncRunner {
  const { gitea, enabled, serviceRoleClient } = opts;
  if (!gitea || !enabled) return NOOP;
  const log = opts.log ?? ((m: string) => console.warn(m));
  return {
    async app(appId) {
      try {
        const admin = await serviceRoleClient("mirror app access to gitea");
        await syncAppToGitea({ gitea, admin, log }, appId);
      } catch (e) {
        log(`[gitea-sync] app ${appId} not synced (reconcile will retry): ${String((e as Error)?.message ?? e)}`);
      }
    },
    async team(teamId) {
      try {
        const admin = await serviceRoleClient("mirror team membership to gitea");
        await syncTeamAppsToGitea({ gitea, admin, log }, teamId);
      } catch (e) {
        log(`[gitea-sync] team ${teamId} not synced (reconcile will retry): ${String((e as Error)?.message ?? e)}`);
      }
    },
  };
}
