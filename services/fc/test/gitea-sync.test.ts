import test from "node:test";
import assert from "node:assert/strict";
import { appsRepo, appsSupabase, fakeGitea } from "./fixtures/apps-repository.js";
import {
  giteaHttpUrlFromRemote,
  giteaOrgName,
  giteaTeamName,
  giteaUserName,
  isTeamCluOrgOwner,
  repoOwnerFromRemote,
} from "../src/lib/provisioning/gitea.js";
import { reconcileGiteaApps, syncAppToGitea } from "../src/lib/provisioning/gitea-sync.js";
import { giteaAccountAuthEnabled } from "../src/lib/provisioning/gitea-sync-runner.js";
import { isGiteaReconcileMinute } from "../src/lib/routes/apps.js";
import { mapApp } from "../src/lib/supabase-repo/shared.js";

const ORG = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const OWNER = giteaOrgName(ORG);
const TEAM = "team-1";
const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT_USER = "aaaaaaaa-0000-4000-8000-000000000002";
const MATE_USER = "aaaaaaaa-0000-4000-8000-000000000003";

const actors = [
  { id: "owner", team_id: TEAM, actor_type: "member", user_id: OWNER_USER, display_name: "张三" },
  { id: "agent", team_id: TEAM, actor_type: "agent", user_id: AGENT_USER, display_name: "小助手" },
  { id: "unclaimed", team_id: TEAM, actor_type: "agent", user_id: null, display_name: "离线助手" },
  { id: "mate", team_id: TEAM, actor_type: "member", user_id: MATE_USER, display_name: "李四" },
  { id: "outsider", team_id: "team-2", actor_type: "member", user_id: "aaaaaaaa-0000-4000-8000-000000000009", display_name: "外人" },
  { id: "contact", team_id: TEAM, actor_type: "external", user_id: null, display_name: "企微联系人" },
];

function orgApp(over: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    team_id: TEAM,
    org_id: ORG,
    visibility: "personal",
    created_by_actor_id: "owner",
    git_auth_kind: "gitea_deploy_key",
    git_remote_url: `git@gitea.example:${OWNER}/tc-app-app-1.git`,
    ...over,
  };
}

// ── naming ────────────────────────────────────────────────────────────────

test("gitea names are derived from TeamClu ids and fit Gitea's 40-character limit", () => {
  assert.equal(giteaUserName("AAAAAAAA-0000-4000-8000-000000000001"), "uaaaaaaaa000040008000000000000001");
  assert.equal(giteaUserName(OWNER_USER).length, 33);
  assert.equal(giteaOrgName(ORG), "o6f1c2d3e4b5a4c6d8e9f0a1b2c3d4e5f");
  assert.equal(giteaTeamName("11111111-2222-4333-8444-555555555555"), "t11111111222243338444555555555555");
  assert.equal(isTeamCluOrgOwner(OWNER), true);
  assert.equal(isTeamCluOrgOwner("teamclaw-apps"), false);
});

test("repo owner and HTTPS address are read from every remote shape", () => {
  assert.equal(repoOwnerFromRemote("git@gitea.example:teamclaw-apps/tc-app-1.git"), "teamclaw-apps");
  assert.equal(repoOwnerFromRemote(`ssh://git@gitea.example:2222/${OWNER}/tc-app-1.git`), OWNER);
  assert.equal(repoOwnerFromRemote(`https://gitea.example/${OWNER}/tc-app-1.git`), OWNER);
  assert.equal(repoOwnerFromRemote("not a url"), null);
  assert.equal(repoOwnerFromRemote(null), null);

  assert.equal(giteaHttpUrlFromRemote(`git@gitea.example:${OWNER}/tc-app-1.git`), `https://gitea.example/${OWNER}/tc-app-1.git`);
  // The SSH port is not the HTTPS port.
  assert.equal(giteaHttpUrlFromRemote(`ssh://git@gitea.example:2222/${OWNER}/tc-app-1.git`), `https://gitea.example/${OWNER}/tc-app-1.git`);
  assert.equal(giteaHttpUrlFromRemote(`https://gitea.example/${OWNER}/tc-app-1.git`), `https://gitea.example/${OWNER}/tc-app-1.git`);
  assert.equal(giteaHttpUrlFromRemote(""), null);
});

test("GITEA_ACCOUNT_AUTH is off unless it says on", () => {
  assert.equal(giteaAccountAuthEnabled({}), false);
  assert.equal(giteaAccountAuthEnabled({ GITEA_ACCOUNT_AUTH: "off" }), false);
  assert.equal(giteaAccountAuthEnabled({ GITEA_ACCOUNT_AUTH: " ON " }), true);
});

test("the reconcile runs on every tenth minute", () => {
  assert.equal(isGiteaReconcileMinute(new Date("2026-11-17T08:20:00Z")), true);
  assert.equal(isGiteaReconcileMinute(new Date("2026-11-17T08:21:00Z")), false);
});

// ── syncAppToGitea ────────────────────────────────────────────────────────

test("sync mirrors the creator and every grant onto the repo, and nothing else", async () => {
  const admin = appsSupabase({
    seed: {
      apps: [orgApp()],
      actors,
      app_member_access: [
        { app_id: "app-1", member_id: "agent", permission_level: "write" },
        { app_id: "app-1", member_id: "unclaimed", permission_level: "write" },
        { app_id: "app-1", member_id: "outsider", permission_level: "read" },
        { app_id: "app-1", member_id: "mate", permission_level: "prompt" }, // pre-rename row
      ],
    },
  });
  const gitea = fakeGitea();
  // A collaborator TeamClu does not know about, left by hand or by a past bug.
  await gitea.withOwner(OWNER).setCollaborator("app-1", "ustranger", "admin");

  const result = await syncAppToGitea({ gitea, admin }, "app-1");
  assert.deepEqual(result, { status: "synced", owner: OWNER, collaborators: 3, teamMembers: null });

  const collaborators = Object.fromEntries(await gitea.withOwner(OWNER).listCollaborators("app-1").then((l: any[]) => l.map((c) => [c.username, c.permission])));
  assert.deepEqual(collaborators, {
    [giteaUserName(OWNER_USER)]: "admin",
    [giteaUserName(AGENT_USER)]: "write",
    [giteaUserName(MATE_USER)]: "write",
  });
  // The agent is named as one in Gitea.
  assert.equal(gitea.state.users.get(giteaUserName(AGENT_USER)), "小助手 · agent");
  assert.equal(gitea.state.users.get(giteaUserName(OWNER_USER)), "张三");
  assert.ok(gitea.state.orgs.has(OWNER));
});

test("sync is idempotent: a second run changes nothing", async () => {
  const admin = appsSupabase({
    seed: { apps: [orgApp()], actors, app_member_access: [{ app_id: "app-1", member_id: "agent", permission_level: "read" }] },
  });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const before = gitea.ops.filter((o: any[]) => o[0] === "setCollaborator" || o[0] === "removeCollaborator").length;
  await syncAppToGitea({ gitea, admin }, "app-1");
  const after = gitea.ops.filter((o: any[]) => o[0] === "setCollaborator" || o[0] === "removeCollaborator").length;
  assert.equal(after, before);
});

test("a team-visible app is read by the whole team through its Gitea team; personal takes it away", async () => {
  const state = { apps: [orgApp({ visibility: "team" })], actors, app_member_access: [] as any[] };
  const admin = appsSupabase({ seed: state });
  const gitea = fakeGitea();

  const result = await syncAppToGitea({ gitea, admin }, "app-1");
  assert.equal(result.status, "synced");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team, "the TeamClu team has a Gitea team under the org");
  // People and connected agents; no external contact, no unclaimed agent, no outsider.
  assert.deepEqual([...team.members].sort(), [OWNER_USER, AGENT_USER, MATE_USER].map(giteaUserName).sort());
  assert.ok(team.repos.has(`${OWNER}/tc-app-app-1`));

  // Switching the app to personal removes the team's access, not the team.
  const personal = appsSupabase({ seed: { ...state, apps: [orgApp({ visibility: "personal" })] } });
  await syncAppToGitea({ gitea, admin: personal }, "app-1");
  assert.equal(team.repos.has(`${OWNER}/tc-app-app-1`), false);
});

test("legacy repos and imported apps are left alone", async () => {
  const gitea = fakeGitea();
  const legacy = appsSupabase({ seed: { apps: [orgApp({ git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git" })], actors } });
  assert.deepEqual(await syncAppToGitea({ gitea, admin: legacy }, "app-1"), { status: "skipped", reason: "legacy_owner" });
  const imported = appsSupabase({ seed: { apps: [orgApp({ git_auth_kind: null, git_remote_url: "https://github.com/o/r.git" })], actors } });
  assert.deepEqual(await syncAppToGitea({ gitea, admin: imported }, "app-1"), { status: "skipped", reason: "not_gitea" });
  assert.deepEqual(gitea.ops, []);
});

test("reconcile syncs managed apps, skips legacy ones, and stops at its deadline", async () => {
  const admin = appsSupabase({
    seed: {
      apps: [
        orgApp({ id: "app-1" }),
        orgApp({ id: "app-2", git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-2.git" }),
      ],
      actors,
    },
  });
  const gitea = fakeGitea();
  const out = await reconcileGiteaApps({ gitea, admin });
  assert.deepEqual(out, { synced: 1, failed: 0, skipped: 1, truncated: false });

  const late = await reconcileGiteaApps({ gitea, admin }, { deadline: Date.now() - 1 });
  assert.equal(late.truncated, true);
});

// ── repository wiring ─────────────────────────────────────────────────────

test("with GITEA_ACCOUNT_AUTH a new app's repo goes under its org and its creator becomes admin", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({
    calls,
    seed: {
      teams: [{ id: "team-1", oid: ORG }],
      actors: [{ id: "actor-app-1", team_id: "team-1", actor_type: "member", user_id: OWNER_USER, display_name: "张三" }],
    },
    appInsertDefaults: { org_id: ORG, team_id: "team-1", created_by_actor_id: "actor-app-1", app_code: "a-k7m2q9vx4n8p" },
  });
  const gitea = fakeGitea();
  const repo = appsRepo(supabase, { gitea, giteaAccountAuth: true, createServiceRoleClient: () => supabase.serviceRole() });
  await repo.createApp({ teamId: "team-1", name: "Org App", type: "static_web", visibility: "personal" });

  // The org comes from the inserted row (createApp resolves it from the team).
  const inserted = calls.find((c) => c.table === "apps" && c.op === "insert");
  const owner = giteaOrgName(inserted.row.org_id);
  const created = gitea.ops.find((o: any[]) => o[0] === "createAppRepo");
  assert.equal(created?.[1], owner, "the repo is created under the TeamClu org");
  const update = calls.find((c) => c.table === "apps" && c.op === "update" && c.row.git_remote_url);
  assert.match(update.row.git_remote_url, new RegExp(`:${owner}/tc-app-`));
  assert.equal(update.row.git_auth_kind, "gitea_deploy_key", "the stored auth kind stays the same for old daemons");
  assert.ok(
    gitea.ops.some((o: any[]) => o[0] === "setCollaborator" && o[2] === giteaUserName(OWNER_USER) && o[3] === "admin"),
    "the creator is mirrored as admin",
  );
});

test("without GITEA_ACCOUNT_AUTH a new app keeps the shared owner and nothing is mirrored", async () => {
  const supabase = appsSupabase({
    appInsertDefaults: { org_id: ORG, team_id: "team-1", created_by_actor_id: "actor-app-1", app_code: "a-k7m2q9vx4n8p" },
  });
  const gitea = fakeGitea();
  const repo = appsRepo(supabase, { gitea, giteaAccountAuth: false, createServiceRoleClient: () => supabase.serviceRole() });
  await repo.createApp({ teamId: "team-1", name: "Old App", type: "static_web", visibility: "personal" });
  assert.equal(gitea.ops.find((o: any[]) => o[0] === "createAppRepo")?.[1], "teamclaw-apps");
  assert.equal(gitea.ops.some((o: any[]) => o[0] === "setCollaborator"), false);
});

test("granting and revoking access is mirrored to the repo", async () => {
  const app = { ...orgApp(), id: "app-1", app_code: "a-k7m2q9vx4n8p", created_by_actor_id: "actor-app-1" };
  const seedActors = [
    { id: "actor-app-1", team_id: TEAM, actor_type: "member", user_id: OWNER_USER, display_name: "张三" },
    actors[1],
  ];
  const supabase = appsSupabase({ seed: { apps: [app], actors: seedActors } });
  const gitea = fakeGitea();
  const repo = appsRepo(supabase, { gitea, giteaAccountAuth: true, createServiceRoleClient: () => supabase.serviceRole() });

  await repo.setAppAccess("app-1", "agent", "write");
  const g = gitea.withOwner(OWNER);
  assert.equal((await g.listCollaborators("app-1")).find((c: any) => c.username === giteaUserName(AGENT_USER))?.permission, "write");

  await repo.removeAppAccess("app-1", "agent");
  assert.equal((await g.listCollaborators("app-1")).some((c: any) => c.username === giteaUserName(AGENT_USER)), false);
});

test("a sync failure never fails the grant", async () => {
  const app = { ...orgApp(), app_code: "a-k7m2q9vx4n8p", created_by_actor_id: "actor-app-1" };
  const supabase = appsSupabase({ seed: { apps: [app], actors: [actors[1]] } });
  const gitea = fakeGitea({ ensureOrg: async () => { throw new Error("gitea is down"); } });
  const repo = appsRepo(supabase, { gitea, giteaAccountAuth: true, createServiceRoleClient: () => supabase.serviceRole() });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const row = await repo.setAppAccess("app-1", "agent", "write");
    assert.equal(row?.permissionLevel, "write");
  } finally {
    console.warn = warn;
  }
});

test("app responses tell new clients to use HTTPS only for per-org repos with the switch on", () => {
  const base = { ...orgApp(), app_code: "a-k7m2q9vx4n8p", provision_status: "ready", created_at: "2026-11-17T00:00:00Z", updated_at: "2026-11-17T00:00:00Z" };
  const prev = process.env.GITEA_ACCOUNT_AUTH;
  try {
    process.env.GITEA_ACCOUNT_AUTH = "on";
    const on = mapApp(base);
    assert.equal(on.gitAccountAuth, true);
    assert.equal(on.gitHttpUrl, `https://gitea.example/${OWNER}/tc-app-app-1.git`);
    // The stored values old daemons read are untouched.
    assert.equal(on.gitRemoteUrl, `git@gitea.example:${OWNER}/tc-app-app-1.git`);
    assert.equal(on.gitAuthKind, "gitea_deploy_key");

    const legacy = mapApp({ ...base, git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git" });
    assert.equal(legacy.gitAccountAuth, false);
    assert.equal(legacy.gitHttpUrl, null);

    process.env.GITEA_ACCOUNT_AUTH = "off";
    assert.equal(mapApp(base).gitAccountAuth, false, "turning the switch off sends clients back to SSH");
  } finally {
    if (prev === undefined) delete process.env.GITEA_ACCOUNT_AUTH;
    else process.env.GITEA_ACCOUNT_AUTH = prev;
  }
});
