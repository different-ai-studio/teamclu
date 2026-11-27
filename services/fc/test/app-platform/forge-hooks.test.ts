/**
 * The repository drives the forge only through `AppLifecycleHooks`.
 *
 * A recording fake stands in for the forge, so these tests pin *when* the
 * platform calls which hook and what it does with the answer — independent of
 * Gitea. P1.2 of docs/specs/2026-11-25-app-platform-p1-gitea-out.md.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/lib/http-utils.js";
import { noTeamCluForge, type TeamCluForge, type TeamCluForgeFactory } from "../../src/lib/teamclu-apps/forge.js";
import { appsRepo, appsSupabase } from "../fixtures/apps-repository.js";

function recordingForge(over: Partial<TeamCluForge> = {}) {
  const calls: string[] = [];
  const base = noTeamCluForge()({ serviceRoleClient: async () => null });
  const hooks: TeamCluForge = {
    ...base,
    assertCanHostRepo() { calls.push("assertCanHostRepo"); },
    async provisionRepo(app) { calls.push(`provisionRepo ${app.id}`); return { remoteUrl: "ssh://forge.test/app.git", authKind: "forge_kind" }; },
    provisionFailed(message, details) { calls.push(`provisionFailed ${message}`); return new ApiError(502, "forge_failed", message, { details }); },
    async recordImportedRepo(appId, remoteUrl) { calls.push(`recordImportedRepo ${appId} ${remoteUrl}`); },
    async appAccessChanged(appId) { calls.push(`appAccessChanged ${appId}`); },
    async teamAccessChanged(teamId) { calls.push(`teamAccessChanged ${teamId}`); },
    async memberWriteRevoked(appId, memberId) { calls.push(`memberWriteRevoked ${appId} ${memberId}`); },
    decorate: () => ({ forgeField: "from-the-forge" }),
    ...over,
  };
  const factory: TeamCluForgeFactory = () => hooks;
  return { calls, factory };
}

const APP_ROW = {
  app_code: "a-k7m2q9vx4n8p",
  id: "app-1",
  team_id: "team-1",
  created_by_actor_id: "actor-app-1",
  name: "My App",
  slug: "my-app",
  type: "fullstack_tanstack_postgres",
  visibility: "team",
  workspace_id: "ws-1",
  git_remote_url: null,
  git_commit_sha: null,
  runtime: "node",
  start_spec: { command: ["node"], args: ["server.js"], port: 3000 },
  auth_mode: "none",
  oauth_client_id: null,
  provision_status: "pending",
  fc_status: null,
  created_at: "2026-06-13T00:00:00Z",
  updated_at: "2026-06-13T00:00:00Z",
};

test("a hosted app: the forge is asked first, provisions the repo, and hears about access", async () => {
  const { calls, factory } = recordingForge();
  const db: any[] = [];
  const repo = appsRepo(appsSupabase({ calls: db }), { forge: factory });
  const app: any = await repo.createApp({ teamId: "team-1", name: "Hosted", type: "static_web" });
  const appId = app.id;
  assert.deepEqual(calls, ["assertCanHostRepo", `provisionRepo ${appId}`, `appAccessChanged ${appId}`]);
  const update = db.find((c) => c.table === "apps" && c.op === "update" && c.row.provision_status === "repo_created");
  assert.equal(update?.row.git_remote_url, "ssh://forge.test/app.git", "the platform stores what the forge answered");
  assert.equal(update?.row.git_auth_kind, "forge_kind");
  assert.equal(app.forgeField, "from-the-forge", "responses carry the forge's fields");
});

test("imported and local apps provision nothing; an import is recorded with the forge", async () => {
  const cases: [Record<string, unknown>, (id: string) => string[]][] = [
    [{ gitRemoteUrl: "https://github.com/owner/repo.git" }, (id) => [`recordImportedRepo ${id} https://github.com/owner/repo.git`]],
    [{ localOnly: true }, () => []],
  ];
  for (const [extra, expected] of cases) {
    const { calls, factory } = recordingForge();
    const repo = appsRepo(appsSupabase(), { forge: factory });
    const app: any = await repo.createApp({ teamId: "team-1", name: "Elsewhere", type: "imported", ...extra });
    assert.deepEqual(calls, expected(app.id), JSON.stringify(extra));
  }
});

test("a failed provision is recorded on the row, then surfaces as the forge's own error", async () => {
  const { calls, factory } = recordingForge({
    async provisionRepo() { throw new Error("forge down"); },
  });
  const db: any[] = [];
  const repo = appsRepo(appsSupabase({ calls: db }), { forge: factory });
  await assert.rejects(
    () => repo.createApp({ teamId: "team-1", name: "Broken", type: "static_web" }),
    (e: any) => e.code === "forge_failed" && e.statusCode === 502 && e.details?.app?.provisionStatus === "error",
  );
  assert.ok(calls.includes("provisionFailed forge down"));
  assert.ok(!calls.some((c) => c.startsWith("appAccessChanged")), "nothing to mirror for a repo that does not exist");
  const errored = db.find((c) => c.table === "apps" && c.op === "update" && c.row.provision_status === "error");
  assert.match(errored?.row.provision_error, /forge down/);
});

test("with no forge, a hosted app is refused before any row is written", async () => {
  const db: any[] = [];
  const repo = appsRepo(appsSupabase({ calls: db }), { forge: noTeamCluForge() });
  await assert.rejects(
    () => repo.createApp({ teamId: "team-1", name: "Nowhere", type: "static_web" }),
    (e: any) => e.code === "repo_hosting_unavailable" && e.statusCode === 503,
  );
  assert.equal(db.find((c) => c.table === "apps" && c.op === "insert"), undefined);
});

test("removing a grant tells the forge the member lost write, then that access changed", async () => {
  const { calls, factory } = recordingForge();
  const admin = appsSupabase({
    seed: {
      apps: [APP_ROW],
      app_member_access: [{ id: "access-1", app_id: "app-1", member_id: "member-2", permission_level: "write", granted_by_member_id: "actor-app-1", created_at: "2026-08-27T00:00:00.000Z" }],
    },
  });
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }), { createServiceRoleClient: () => admin, forge: factory });
  assert.equal(await repo.removeAppAccess("app-1", "member-2"), true);
  assert.deepEqual(calls, ["memberWriteRevoked app-1 member-2", "appAccessChanged app-1"]);
});
