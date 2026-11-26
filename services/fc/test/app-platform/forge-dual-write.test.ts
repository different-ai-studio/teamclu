/**
 * P3.3 of docs/specs/2026-11-26-app-platform-p3-retire-legacy.md: where an
 * app's code lives is the forge's record (amux.app_forge_repos), read through
 * `AppLifecycleHooks.repos`, and every write of apps.git_remote_url /
 * git_auth_kind also writes that record directly. The legacy columns are
 * still written (and projected by 20261127200000's trigger) so a P3.2 image
 * can roll back; these direct writes are what remains once P3.4 drops them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { noTeamCluForge, type TeamCluForgeFactory } from "../../src/lib/teamclu-apps/forge.js";
import { appsRepo, appsSupabase } from "../fixtures/apps-repository.js";

const IMPORTED = {
  app_code: "a-k7m2q9vx4n8p",
  id: "app-1",
  team_id: "team-1",
  org_id: "org-1",
  created_by_actor_id: "actor-app-1",
  workspace_id: "ws-1",
  name: "Imported",
  slug: "imported",
  type: "imported",
  visibility: "personal",
  git_remote_url: "https://github.com/owner/private.git",
  git_auth_kind: null,
  provision_status: "ready",
  created_at: "2026-11-26T00:00:00Z",
  updated_at: "2026-11-26T00:00:00Z",
};

function withAppSecretsKey(fn: () => Promise<void>) {
  return async () => {
    const prev = process.env.APP_SECRETS_ENCRYPTION_KEY;
    process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.APP_SECRETS_ENCRYPTION_KEY;
      else process.env.APP_SECRETS_ENCRYPTION_KEY = prev;
    }
  };
}

test("an imported app's repo is recorded with the forge, and the legacy column written too", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({ calls });
  const repo = appsRepo(supabase, { createServiceRoleClient: () => supabase });
  await repo.createApp({ teamId: "team-1", name: "Imp", type: "imported", gitRemoteUrl: "https://github.com/owner/repo.git" });
  const insert = calls.find((c) => c.table === "apps" && c.op === "insert");
  assert.equal(insert?.row.git_remote_url, "https://github.com/owner/repo.git");
  const record = calls.find((c) => c.table === "app_forge_repos" && c.op === "upsert");
  assert.equal(record?.row.remote_url, "https://github.com/owner/repo.git");
  assert.equal(record?.row.auth_kind, null);
  assert.equal(record?.options?.onConflict, "app_id");
});

test("a repo the Gitea forge provisions is recorded by the forge", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({ calls });
  const repo = appsRepo(supabase, { createServiceRoleClient: () => supabase });
  await repo.createApp({ teamId: "team-1", name: "Hosted", type: "static_web" });
  const record = calls.find((c) => c.table === "app_forge_repos" && c.op === "upsert");
  assert.match(record?.row.remote_url ?? "", /^git@gitea\.example:/);
  assert.equal(record?.row.auth_kind, "gitea_deploy_key");
  const legacy = calls.find((c) => c.table === "apps" && c.op === "update" && c.row.provision_status === "repo_created");
  assert.equal(legacy?.row.git_auth_kind, "gitea_deploy_key", "the legacy columns follow until P3.4");
});

test(
  "storing and clearing a repo token set the record's auth kind and the legacy column",
  withAppSecretsKey(async () => {
    const calls: any[] = [];
    const supabase = appsSupabase({ calls, seed: { apps: [IMPORTED] } });
    const repo = appsRepo(supabase, { createServiceRoleClient: () => supabase });

    await repo.setAppGitHttpsCredential("app-1", { username: "me", token: "ghp_secret" });
    const stored = calls.filter((c) => c.table === "app_forge_repos" && c.op === "update").map((c) => c.row.auth_kind);
    assert.deepEqual(stored, ["https_token"]);
    assert.ok(calls.some((c) => c.table === "apps" && c.op === "update" && c.row.git_auth_kind === "https_token"));
    const secretAt = calls.findIndex((c) => c.table === "app_secrets" && c.op === "upsert");
    const recordAt = calls.findIndex((c) => c.table === "app_forge_repos" && c.op === "update");
    assert.ok(secretAt >= 0 && secretAt < recordAt, "the secret exists before the record names it");

    calls.length = 0;
    await repo.clearAppGitHttpsCredential("app-1");
    const cleared = calls.filter((c) => c.table === "app_forge_repos" && c.op === "update").map((c) => c.row.auth_kind);
    assert.deepEqual(cleared, [null]);
    const unnamedAt = calls.findIndex((c) => c.table === "app_forge_repos" && c.op === "update");
    const deletedAt = calls.findIndex((c) => c.table === "app_secrets" && c.op === "delete");
    assert.ok(unnamedAt >= 0 && unnamedAt < deletedAt, "the record stops naming the secret before it goes");
  }),
);

test("responses take the repo from the forge's record, not the app row", async () => {
  const base = noTeamCluForge();
  const factory: TeamCluForgeFactory = (ctx) => ({
    ...base(ctx),
    async repos(_client, ids) {
      return new Map(ids.map((id) => [id, { remoteUrl: `https://forge.test/${id}.git`, authKind: "forge_kind" }]));
    },
  });
  const repo = appsRepo(appsSupabase({ seed: { apps: [IMPORTED] } }), { forge: factory });
  const detail: any = await repo.getApp("app-1");
  assert.equal(detail.gitRemoteUrl, "https://forge.test/app-1.git");
  assert.equal(detail.gitAuthKind, "forge_kind");
  const { items } = await repo.listAppsPage({ teamId: "team-1", limit: 10 });
  assert.equal((items[0] as any).gitRemoteUrl, "https://forge.test/app-1.git");
});
