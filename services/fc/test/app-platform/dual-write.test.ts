/**
 * P3.2 of docs/specs/2026-11-26-app-platform-p3-retire-legacy.md: every write
 * of the legacy app model also writes the platform model directly — the
 * creating account, the app's link, its org grant, user grants. P2.1's
 * triggers still project the legacy rows (so a P3.1 image can roll back), and
 * these direct writes are what remains once P3.4 drops them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appsRepo, appsSupabase } from "../fixtures/apps-repository.js";

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
const MEMBER_2 = { id: "member-2", team_id: "team-1", actor_type: "member", user_id: "user-2" };

test("creating an app writes its creating account, its link and its org grant", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls }));
  await repo.createApp({ teamId: "team-1", name: "Fresh", type: "imported", visibility: "team", localOnly: true });

  const insert = calls.find((c) => c.table === "apps" && c.op === "insert");
  assert.equal(insert?.row.created_by_user_id, "user-app-1");
  const ws = calls.find((c) => c.table === "workspaces" && c.op === "insert");
  assert.ok(ws, "the 1:1 workspace is created");

  const link = calls.find((c) => c.table === "app_links" && c.op === "upsert");
  assert.equal(link?.row.team_id, "team-1");
  assert.equal(link?.row.created_by_actor_id, "actor-app-1");
  assert.ok(link?.row.workspace_id, "the link names the new workspace, never null over the projection");
  assert.equal(link?.options?.onConflict, "app_id");

  const org = calls.find((c) => c.table === "app_grants" && c.op === "insert");
  assert.equal(org?.row.principal_org_id, "org-1");
  assert.equal(org?.row.level, "read");
});

test("a personal app gets no org grant", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls }));
  await repo.createApp({ teamId: "team-1", name: "Mine", type: "imported", localOnly: true });
  assert.equal(calls.some((c) => c.table === "app_grants" && c.op === "insert"), false);
});

test("changing visibility sets the org grant; a rename leaves it alone", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls, seed: { apps: [TEAM_APP] } }));

  const writes = () => calls.filter((c) => c.table === "app_grants" && ["insert", "update", "upsert", "delete"].includes(c.op));

  await repo.updateApp("app-1", { name: "Renamed" });
  assert.deepEqual(writes(), [], "a rename writes no grant");

  await repo.updateApp("app-1", { visibility: "personal" });
  assert.deepEqual(writes().map((c) => c.op), ["delete"], "personal removes the org grant");

  await repo.updateApp("app-1", { visibility: "team" });
  const ins = calls.find((c) => c.table === "app_grants" && c.op === "insert");
  assert.deepEqual(ins?.row, { app_id: "app-1", principal_org_id: "org-1", level: "read" });
});

test("granting writes the account's grant, named by account; revoking removes it", async () => {
  const calls: any[] = [];
  const db = appsSupabase({ calls, seed: { apps: [TEAM_APP], actors: [MEMBER_2] } });
  const repo = appsRepo(db);

  await repo.setAppAccess("app-1", "member-2", "write");
  const upd = calls.find((c) => c.table === "app_grants" && c.op === "update");
  assert.equal(upd?.row.level, "write");
  assert.equal(upd?.row.granted_by_user_id, "user-app-1");
  const byUser = calls.find((c) => c.table === "app_grants" && c.op === "update.eq" && c.column === "principal_user_id");
  assert.equal(byUser?.value, "user-2");
  const ins = calls.find((c) => c.table === "app_grants" && c.op === "insert");
  assert.deepEqual(ins?.row, { app_id: "app-1", principal_user_id: "user-2", level: "write", granted_by_user_id: "user-app-1" });

  await repo.removeAppAccess("app-1", "member-2");
  const del = calls.findIndex((c) => c.table === "app_grants" && c.op === "delete");
  assert.ok(del >= 0);
  assert.ok(calls.slice(del).some((c) => c.table === "app_grants" && c.column === "principal_user_id" && c.value === "user-2"));
});
