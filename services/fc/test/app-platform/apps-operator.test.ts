/**
 * The platform records who acted by account (P2.4b): env vars and cron jobs
 * write the `*_by_user_id` columns P2.1 added, not the legacy member columns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appsRepo, appsSupabase } from "../fixtures/apps-repository.js";

const APP = {
  id: "app-1",
  team_id: "team-1",
  org_id: "org-1",
  created_by_actor_id: "actor-app-1",
  name: "Operator app",
  slug: "operator-app",
  type: "static_web",
};

test("an env var write names the account and clears the legacy member column", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP] }, calls }));
  await repo.putAppEnv("app-1", "GREETING", { value: "hi" });
  const write = calls.find((c) => c.table === "app_env_vars" && c.op === "upsert");
  assert.equal(write?.row.updated_by_user_id, "user-app-1");
  // Left out, an upsert over an older member writer's row would keep that
  // member, and P2.1's trigger would copy their account over this one.
  assert.ok("updated_by_member_id" in write.row && write.row.updated_by_member_id === null);
});

test("a cron job records the account that created it", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP] }, calls }));
  await repo.createAppCronJob("app-1", { name: "nightly", schedule: "0 0 * * *", path: "/cron" });
  const insert = calls.find((c) => c.table === "app_cron_jobs" && c.op === "insert");
  assert.equal(insert?.row.created_by_user_id, "user-app-1");
  assert.equal("created_by_member_id" in insert.row, false);
});
