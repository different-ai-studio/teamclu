/**
 * TeamClu's record of where each app's code lives: `amux.app_forge_repos`
 * (P3.3 of docs/specs/2026-11-26-app-platform-p3-retire-legacy.md, the
 * original P1.5). It replaces `apps.git_remote_url` / `git_auth_kind`.
 *
 * Until P3.4 drops those columns the platform still writes them, and a
 * trigger projects them here first, so each write below is idempotent: it
 * settles the row whether or not the projection already did.
 *
 * Reads take whichever client the caller holds: the caller's token reads the
 * repos of the apps it sees (20261127200000); the service role reads any.
 * Writes are the forge's, with the service role.
 */
import type { AppRepo, AppRepoRow } from "../app-platform/hooks.js";
import { chunkedIn } from "../supabase-repo/shared.js";

export const FORGE_REPO_COLUMNS = "app_id, remote_url, auth_kind";

export async function readForgeRepos(client: any, appIds: string[]): Promise<Map<string, AppRepo>> {
  const ids = [...new Set(appIds.filter(Boolean))];
  const out = new Map<string, AppRepo>();
  if (ids.length === 0) return out;
  const rows = await chunkedIn(ids, async (chunk) => {
    const { data, error } = await client.from("app_forge_repos").select(FORGE_REPO_COLUMNS).in("app_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  for (const r of rows as any[]) out.set(r.app_id, { remoteUrl: r.remote_url, authKind: r.auth_kind ?? null });
  return out;
}

/** One app as a forge sees it — its id and org, plus its repo — or null when the app has none. */
export async function readForgeApp(admin: any, appId: string): Promise<AppRepoRow | null> {
  const { data, error } = await admin.from("app_forge_repos").select(FORGE_REPO_COLUMNS).eq("app_id", appId).maybeSingle();
  if (error) throw error;
  return data ? forgeAppRow(data) : null;
}

/** A record row as the `AppRepoRow` the forge's functions take. */
export function forgeAppRow(r: { app_id: string; remote_url: string | null; auth_kind: string | null }): AppRepoRow {
  return { id: r.app_id, git_remote_url: r.remote_url, git_auth_kind: r.auth_kind ?? null };
}

export async function writeForgeRepo(admin: any, appId: string, repo: AppRepo): Promise<void> {
  const { error } = await admin.from("app_forge_repos").upsert(
    { app_id: appId, remote_url: repo.remoteUrl, auth_kind: repo.authKind, updated_at: new Date().toISOString() },
    { onConflict: "app_id" },
  );
  if (error) throw error;
}

export async function setForgeRepoAuthKind(admin: any, appId: string, authKind: string | null): Promise<void> {
  const { error } = await admin
    .from("app_forge_repos")
    .update({ auth_kind: authKind, updated_at: new Date().toISOString() })
    .eq("app_id", appId);
  if (error) throw error;
}
