import { ApiError } from "../../http-utils.js";
import { expiredJitDeployKeyIds } from "./deploy-key.js";
import { GITEA_AUTH_KIND, repoOwnerFromRemote, type GiteaClient } from "./client.js";

type ManagedApp = { id: string; git_remote_url: string | null };
type RepoClient = Pick<GiteaClient, "listAllDeployKeys" | "deleteDeployKey">;

async function listManagedApps(client: any, after: string, limit: number, signal: AbortSignal): Promise<ManagedApp[]> {
  let query = client.from("apps").select("id, git_remote_url")
    .eq("git_auth_kind", GITEA_AUTH_KIND).order("id").limit(limit);
  if (after) query = query.gt("id", after);
  const { data, error } = await query.abortSignal(signal);
  if (error) throw error;
  return data ?? [];
}

/** Resume a bounded sweep on each heartbeat. No new credential request is needed. */
export function makeDeployKeyExpirySweep({
  gitea,
  listApps = listManagedApps,
  now = Date.now,
  batchSize = 100,
}: {
  gitea: { owner: string; withOwner(owner: string): RepoClient };
  listApps?: typeof listManagedApps;
  now?: () => number;
  batchSize?: number;
}) {
  let after = "";
  let running = false;

  return async function sweep(client: unknown, deadline: number) {
    const result = { scanned: 0, revoked: 0, failed: 0 };
    if (running || deadline <= now()) return result;
    running = true;
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
      let apps = await listApps(client, after, batchSize, signal);
      if (apps.length === 0 && after) {
        after = "";
        apps = await listApps(client, after, batchSize, signal);
      }
      for (const app of apps) {
        if (signal.aborted || now() >= deadline) break;
        const repo = gitea.withOwner(repoOwnerFromRemote(app.git_remote_url) ?? gitea.owner);
        result.scanned++;
        try {
          const keys = await repo.listAllDeployKeys(app.id, signal);
          for (const id of expiredJitDeployKeyIds(keys, now())) {
            try {
              await repo.deleteDeployKey(app.id, id, signal);
              result.revoked++;
            } catch (error) {
              if (!(error instanceof ApiError && error.statusCode === 404)) result.failed++;
              if (signal.aborted) break;
            }
          }
        } catch {
          result.failed++;
        }
        // A failing repo must not starve later ones. It is retried on the next pass.
        after = app.id;
      }
      return result;
    } finally {
      running = false;
    }
  };
}
