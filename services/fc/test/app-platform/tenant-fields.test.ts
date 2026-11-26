/**
 * TeamClu's fields of an app come from AppTenantHooks.fields — app_links and
 * app_grants — on every response that carries an app, not only list and
 * detail (P3.1 of docs/specs/2026-11-26-app-platform-p3-retire-legacy.md).
 * iOS decodes `teamId` as required, so a response without it breaks a client.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { noTeamCluForge, type TeamCluForgeFactory } from "../../src/lib/teamclu-apps/forge.js";
import { appsRepo, appsSupabase } from "../fixtures/apps-repository.js";

function accessSpy() {
  const changed: string[] = [];
  const base = noTeamCluForge();
  const factory: TeamCluForgeFactory = (ctx) => ({
    ...base(ctx),
    async appAccessChanged(appId: string) { changed.push(appId); },
  });
  return { changed, factory };
}

const TEAM_APP = {
  app_code: "a-k7m2q9vx4n8p",
  id: "app-1",
  team_id: "team-1",
  org_id: "org-1",
  created_by_actor_id: "actor-app-1",
  workspace_id: "ws-1",
  name: "Team app",
  slug: "team-app",
  type: "static_web",
  visibility: "team",
  provision_status: "pending",
  created_at: "2026-11-26T00:00:00Z",
  updated_at: "2026-11-26T00:00:00Z",
};

test("a created app answers with its team, workspace, creator and visibility", async () => {
  const repo = appsRepo(appsSupabase());
  const app: any = await repo.createApp({ teamId: "team-1", name: "Fresh", type: "imported", visibility: "team", localOnly: true });
  assert.equal(app.teamId, "team-1");
  assert.equal(app.visibility, "team");
  assert.equal(app.createdByActorId, "actor-app-1");
  assert.ok(app.workspaceId, "the 1:1 workspace is named");
});

test("an update answers with the fields as they now are, and a visibility change is an access change", async () => {
  const { changed, factory } = accessSpy();
  const repo = appsRepo(appsSupabase({ seed: { apps: [TEAM_APP] } }), { forge: factory });

  const renamed: any = await repo.updateApp("app-1", { name: "Renamed" });
  assert.equal(renamed.teamId, "team-1");
  assert.equal(renamed.visibility, "team");
  assert.deepEqual(changed, [], "a rename changes nobody's access");

  const hidden: any = await repo.updateApp("app-1", { visibility: "personal" });
  assert.equal(hidden.visibility, "personal");
  assert.equal(hidden.workspaceId, "ws-1");
  assert.deepEqual(changed, ["app-1"]);
});

test("the platform's own select names none of TeamClu's legacy columns", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ seed: { apps: [TEAM_APP] }, calls }));
  await repo.getApp("app-1");
  await repo.listApps({ teamId: "team-1", limit: 10 });
  for (const c of calls.filter((c) => c.table === "apps" && typeof c.columns === "string")) {
    const columns = c.columns.replace(/app_links!inner\([^)]*\)/g, "");
    for (const legacy of ["team_id", "created_by_actor_id", "workspace_id", "visibility"]) {
      assert.doesNotMatch(columns, new RegExp(`\\b${legacy}\\b`), `${legacy} in "${c.columns}"`);
    }
  }
});
