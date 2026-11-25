import test from "node:test";
import assert from "node:assert/strict";
import { appsRepo, appsSupabase, fakeGitea } from "./fixtures/apps-repository.js";
import { giteaOrgName, giteaUserName } from "../src/lib/forge/gitea/client.js";
import { syncAppToGitea } from "../src/lib/forge/gitea/sync.js";
import { appGitLevel } from "../src/lib/forge/app-git-access.js";
import { higherAppLevel } from "../src/lib/app-permission.js";
import { inheritedRepoLevel } from "../src/lib/forge/app-git-access.js";

// An active agent reaches the apps its owner reaches (20261120120000), at its
// owner's level, minus the two things a bot never does for its owner: change
// who has access, and delete the app.

const TEAM = "team-1";
const ORG = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const OWNER = giteaOrgName(ORG);

const CREATOR = { id: "creator", team_id: TEAM, actor_type: "member", user_id: "aaaaaaaa-0000-4000-8000-000000000001", display_name: "张三" };
const GRANTEE = { id: "grantee", team_id: TEAM, actor_type: "member", user_id: "aaaaaaaa-0000-4000-8000-000000000002", display_name: "李四" };
const CREATOR_BOT = { id: "creator-bot", team_id: TEAM, actor_type: "agent", user_id: "aaaaaaaa-0000-4000-8000-000000000011", display_name: "张三的Bot" };
const GRANTEE_BOT = { id: "grantee-bot", team_id: TEAM, actor_type: "agent", user_id: "aaaaaaaa-0000-4000-8000-000000000012", display_name: "李四的Bot" };
const RETIRED_BOT = { id: "retired-bot", team_id: TEAM, actor_type: "agent", user_id: "aaaaaaaa-0000-4000-8000-000000000013", display_name: "旧Bot" };

const APP = {
  id: "app-1",
  team_id: TEAM,
  org_id: ORG,
  name: "预测取数",
  visibility: "personal",
  created_by_actor_id: "creator",
  fc_status: "not_deployed",
  git_auth_kind: "gitea_deploy_key",
  git_remote_url: `git@gitea.example:${OWNER}/tc-app-app-1.git`,
};

function seed(over: Record<string, unknown> = {}) {
  return {
    apps: [APP],
    actors: [CREATOR, GRANTEE, CREATOR_BOT, GRANTEE_BOT, RETIRED_BOT],
    agents: [
      { id: "creator-bot", owner_member_id: "creator", status: "active" },
      { id: "grantee-bot", owner_member_id: "grantee", status: "active" },
      { id: "retired-bot", owner_member_id: "creator", status: "archived" },
    ],
    app_member_access: [{ app_id: "app-1", member_id: "grantee", permission_level: "write", granted_by_member_id: "creator", created_at: "2026-11-20T00:00:00.000Z" }],
    ...over,
  };
}

const asCaller = (actor: any, over: Record<string, unknown> = {}) =>
  appsRepo(appsSupabase({ seed: seed(over), actorRow: actor }));

// ── the level ─────────────────────────────────────────────────────────────

test("the creator's agent inherits admin, marked inherited", async () => {
  assert.deepEqual(await asCaller(CREATOR_BOT).resolveAppCallerPermissionForApp(APP), {
    level: "admin",
    callerActorId: "creator-bot",
    callerMemberId: null,
    inherited: true,
  });
});

test("a grantee's agent inherits the grantee's level", async () => {
  const p = await asCaller(GRANTEE_BOT).resolveAppCallerPermissionForApp(APP);
  assert.equal(p?.level, "write");
  assert.equal(p?.inherited, true);
});

test("an archived agent inherits nothing", async () => {
  assert.equal(await asCaller(RETIRED_BOT).resolveAppCallerPermissionForApp(APP), null);
});

test("revoking the owner takes the agent's access with it", async () => {
  assert.equal(await asCaller(GRANTEE_BOT, { app_member_access: [] }).resolveAppCallerPermissionForApp(APP), null);
});

test("the higher of an own grant and the inherited level wins; an own grant that wins is not inherited", async () => {
  const lowerOwn = await asCaller(GRANTEE_BOT, {
    app_member_access: [
      ...seed().app_member_access,
      { app_id: "app-1", member_id: "grantee-bot", permission_level: "read" },
    ],
  }).resolveAppCallerPermissionForApp(APP);
  assert.deepEqual([lowerOwn?.level, lowerOwn?.inherited], ["write", true]);

  const higherOwn = await asCaller(GRANTEE_BOT, {
    app_member_access: [
      ...seed().app_member_access,
      { app_id: "app-1", member_id: "grantee-bot", permission_level: "admin" },
    ],
  }).resolveAppCallerPermissionForApp(APP);
  assert.deepEqual([higherOwn?.level, higherOwn?.inherited], ["admin", false]);
});

test("a member never inherits (only agents do)", async () => {
  assert.equal(
    await asCaller({ ...GRANTEE, id: "grantee" }, { app_member_access: [] }).resolveAppCallerPermissionForApp(APP),
    null,
  );
});

// ── what an inherited caller may not do ───────────────────────────────────

test("an agent with inherited admin cannot change who has access", async () => {
  const repo = asCaller(CREATOR_BOT);
  for (const call of [
    () => repo.listAppAccess("app-1"),
    () => repo.setAppAccess("app-1", "grantee-bot", "write"),
    () => repo.removeAppAccess("app-1", "grantee"),
  ]) {
    await assert.rejects(call, (e: any) => e.statusCode === 403 && e.code === "inherited_access_not_allowed");
  }
});

test("an agent with inherited admin cannot delete the app", async () => {
  await assert.rejects(
    () => asCaller(CREATOR_BOT).deleteApp("app-1"),
    (e: any) => e.statusCode === 403 && e.code === "inherited_access_not_allowed",
  );
});

test("an explicitly granted admin agent still manages access", async () => {
  const repo = asCaller(GRANTEE_BOT, {
    app_member_access: [
      ...seed().app_member_access,
      { app_id: "app-1", member_id: "grantee-bot", permission_level: "admin" },
    ],
  });
  assert.ok(Array.isArray(await repo.listAppAccess("app-1")));
});

// ── the access tab ────────────────────────────────────────────────────────

test("the access list names every grantee and lists inherited agents read-only", async () => {
  const items = await asCaller(CREATOR).listAppAccess("app-1");
  assert.deepEqual(items, [
    {
      memberId: "grantee",
      permissionLevel: "write",
      grantedByMemberId: "creator",
      createdAt: "2026-11-20T00:00:00.000Z",
      actorType: "member",
      connected: true,
      displayName: "李四",
      inherited: false,
      inheritedFrom: null,
    },
    {
      memberId: "creator-bot",
      permissionLevel: "admin",
      grantedByMemberId: null,
      createdAt: null,
      actorType: "agent",
      connected: true,
      displayName: "张三的Bot",
      inherited: true,
      inheritedFrom: { actorId: "creator", displayName: "张三" },
    },
    {
      memberId: "grantee-bot",
      permissionLevel: "write",
      grantedByMemberId: null,
      createdAt: null,
      actorType: "agent",
      connected: true,
      displayName: "李四的Bot",
      inherited: true,
      inheritedFrom: { actorId: "grantee", displayName: "李四" },
    },
  ]);
});

test("an agent with its own grant is listed once, as granted", async () => {
  const items = await asCaller(CREATOR, {
    app_member_access: [
      ...seed().app_member_access,
      { app_id: "app-1", member_id: "creator-bot", permission_level: "read", created_at: "2026-11-20T01:00:00.000Z" },
    ],
  }).listAppAccess("app-1");
  const rows = (items ?? []).filter((r: any) => r.memberId === "creator-bot");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inherited, false);
});

// ── Gitea ─────────────────────────────────────────────────────────────────

test("sync mirrors inherited agents as collaborators, admin capped at write", async () => {
  const admin = appsSupabase({ seed: seed() });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const collaborators = Object.fromEntries(
    (await gitea.withOwner(OWNER).listCollaborators("app-1")).map((c: any) => [c.username, c.permission]),
  );
  assert.deepEqual(collaborators, {
    [giteaUserName(CREATOR.user_id)]: "admin",
    [giteaUserName(GRANTEE.user_id)]: "write",
    [giteaUserName(CREATOR_BOT.user_id)]: "write",
    [giteaUserName(GRANTEE_BOT.user_id)]: "write",
  });
});

test("sync drops an agent's collaborator access when its owner's grant goes", async () => {
  const state = seed();
  const admin = appsSupabase({ seed: state });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const after = appsSupabase({ seed: { ...state, app_member_access: [] } });
  await syncAppToGitea({ gitea, admin: after }, "app-1");
  const names = (await gitea.withOwner(OWNER).listCollaborators("app-1")).map((c: any) => c.username);
  assert.equal(names.includes(giteaUserName(GRANTEE_BOT.user_id)), false);
  assert.equal(names.includes(giteaUserName(CREATOR_BOT.user_id)), true);
});

// ── the credential helper's "why was I refused" ───────────────────────────

test("git access counts an inherited level as Gitea enforces it", () => {
  assert.equal(appGitLevel({ isCreator: false, grant: null, inherited: "admin", visibility: "personal" }), "write");
  assert.equal(appGitLevel({ isCreator: false, grant: "read", inherited: "write", visibility: "personal" }), "write");
  assert.equal(appGitLevel({ isCreator: false, grant: null, inherited: null, visibility: "personal" }), null);
  assert.equal(inheritedRepoLevel("read"), "read");
  assert.equal(higherAppLevel(null, "read"), "read");
});

// ── before the migration ──────────────────────────────────────────────────

test("a database without the inheritance functions reads as no inheritance, not as an error", async () => {
  for (const code of ["PGRST202", "42883"]) {
    const client = appsSupabase({ seed: seed(), actorRow: CREATOR_BOT });
    const realRpc = client.rpc.bind(client);
    client.rpc = async (name: string, args: any) =>
      name === "app_inherited_agents" || name === "agent_inherited_app_level"
        ? { data: null, error: { code, message: "function does not exist" } }
        : realRpc(name, args);
    const repo = appsRepo(client);
    assert.equal(await repo.resolveAppCallerPermissionForApp(APP), null, code);
  }
});

test("any other database error from the inheritance functions is raised", async () => {
  const client = appsSupabase({ seed: seed(), actorRow: CREATOR_BOT });
  client.rpc = async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  await assert.rejects(() => appsRepo(client).resolveAppCallerPermissionForApp(APP), (e: any) => e.code === "57014");
});
