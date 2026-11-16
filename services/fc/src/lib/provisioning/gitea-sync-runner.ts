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
  /**
   * Re-sync every managed app of a team (someone joined or left it). Resolves
   * when the sync is done or after `teamWaitMs`, whichever is first; the sync
   * itself keeps going either way.
   */
  team(teamId: string): Promise<void>;
}

/**
 * How long a join/leave request waits for its team sync. Long enough that a
 * small team is in step by the time the response lands, short enough that a
 * slow or hung Gitea cannot time the request out — the caller would retry a
 * join that already succeeded.
 */
export const GITEA_TEAM_SYNC_WAIT_MS = 3_000;

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
  teamWaitMs?: number;
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
      const sync = (async () => {
        try {
          const admin = await serviceRoleClient("mirror team membership to gitea");
          await syncTeamAppsToGitea({ gitea, admin, log }, teamId);
        } catch (e) {
          log(`[gitea-sync] team ${teamId} not synced (reconcile will retry): ${String((e as Error)?.message ?? e)}`);
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.teamWaitMs ?? GITEA_TEAM_SYNC_WAIT_MS);
      });
      await Promise.race([sync, waited]);
      clearTimeout(timer);
    },
  };
}
