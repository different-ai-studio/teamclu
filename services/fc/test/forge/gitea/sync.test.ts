import test from "node:test";
import assert from "node:assert/strict";
import { appsRepo, appsSupabase, fakeGitea } from "../../fixtures/apps-repository.js";
import {
  giteaHttpUrlFromRemote,
  giteaOrgName,
  giteaTeamName,
  giteaUserName,
  isTeamCluOrgOwner,
  repoOwnerFromRemote,
} from "../../../src/lib/forge/gitea/client.js";
import { reconcileGiteaApps, syncAppToGitea, syncTeamAppsToGitea } from "../../../src/lib/forge/gitea/sync.js";
import { giteaAccountAuthEnabled, makeGiteaSyncRunner } from "../../../src/lib/forge/gitea/sync-runner.js";
import { giteaAccountFields, isGiteaReconcileMinute } from "../../../src/lib/forge/index.js";
import { readAppGitAccess } from "../../../src/lib/forge/app-git-access.js";
import { mapApp } from "../../../src/lib/supabase-repo/shared.js";

/** An app as the repository answers it: the platform's fields plus the Gitea forge's. */
const view = (r: any): Record<string, unknown> => mapApp(r, giteaAccountFields(r));

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
  // GITEA_PUBLIC_URL wins over the SSH host.
  assert.equal(
    giteaHttpUrlFromRemote(`git@gitea.internal:${OWNER}/tc-app-1.git`, "https://git.example.com/"),
    `https://git.example.com/${OWNER}/tc-app-1.git`,
  );
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

test("an org-visible app grants read to another team in the same org, but not another org", async () => {
  const sameOrgUser = "aaaaaaaa-0000-4000-8000-000000000009";
  const otherOrgUser = "aaaaaaaa-0000-4000-8000-000000000010";
  const seed = {
    apps: [orgApp({ visibility: "team" })],
    teams: [{ id: TEAM, oid: ORG }, { id: "team-2", oid: ORG }, { id: "team-3", oid: "other-org" }],
    actors: [...actors, { id: "foreign", team_id: "team-3", actor_type: "member", user_id: otherOrgUser, display_name: "外组织" }],
  };
  const admin = appsSupabase({ seed, actorRow: null });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team);
  assert.ok(team.members.has(giteaUserName(sameOrgUser)));
  assert.equal(team.members.has(giteaUserName(otherOrgUser)), false);
  assert.equal((await readAppGitAccess(admin, "app-1", sameOrgUser))?.permission, "read");
  assert.equal(await readAppGitAccess(admin, "app-1", otherOrgUser), null);
});

test("a membership change in another org team resyncs org-visible app repos", async () => {
  const lateUser = "aaaaaaaa-0000-4000-8000-000000000011";
  const base = { apps: [orgApp({ visibility: "team" })], teams: [{ id: TEAM, oid: ORG }, { id: "team-2", oid: ORG }], actors };
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin: appsSupabase({ seed: base }) }, "app-1");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team);
  assert.equal(team.members.has(giteaUserName(lateUser)), false);
  const joined = appsSupabase({ seed: { ...base, actors: [...actors, { id: "late", team_id: "team-2", actor_type: "member", user_id: lateUser, display_name: "新成员" }] } });
  await syncTeamAppsToGitea({ gitea, admin: joined }, "team-2");
  assert.ok(team.members.has(giteaUserName(lateUser)));
});

test("leaving the last team in an org removes org-visible Git read access", async () => {
  const user = "aaaaaaaa-0000-4000-8000-000000000009";
  const teams = [{ id: TEAM, oid: ORG }, { id: "team-2", oid: ORG }];
  const app = orgApp({ visibility: "team" });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin: appsSupabase({ seed: { apps: [app], teams, actors }, actorRow: null }) }, "app-1");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team?.members.has(giteaUserName(user)));

  const remaining = actors.filter((actor) => actor.user_id !== user);
  const admin = appsSupabase({ seed: { apps: [app], teams, actors: remaining }, actorRow: null });
  await syncTeamAppsToGitea({ gitea, admin }, "team-2");
  assert.equal(team.members.has(giteaUserName(user)), false);
  assert.equal(await readAppGitAccess(admin, "app-1", user), null);
});

test("org visibility includes actors beyond the first PostgREST page", async () => {
  const members = Array.from({ length: 501 }, (_, i) => ({
    id: `member-${i}`, team_id: TEAM, actor_type: "member",
    user_id: `aaaaaaaa-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    display_name: `Member ${i}`,
  }));
  const admin = appsSupabase({
    seed: { apps: [orgApp({ visibility: "team" })], teams: [{ id: TEAM, oid: ORG }], actors: members },
    actorRow: null, maxRows: 500,
  });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team?.members.has(giteaUserName(members.at(-1)!.user_id)));
});

test("org visibility includes teams beyond the first PostgREST page", async () => {
  const teams = Array.from({ length: 501 }, (_, i) => ({ id: `team-${i}`, oid: ORG }));
  const lastUser = "aaaaaaaa-0000-4000-8000-000000000099";
  const admin = appsSupabase({
    seed: {
      apps: [orgApp({ visibility: "team" })],
      teams: [{ id: TEAM, oid: ORG }, ...teams],
      actors: [actors[0], { id: "last-team-member", team_id: teams.at(-1)!.id, actor_type: "member", user_id: lastUser, display_name: "Last" }],
    },
    actorRow: null, maxRows: 500,
  });
  const gitea = fakeGitea();
  await syncAppToGitea({ gitea, admin }, "app-1");
  const team = gitea.state.teams.get(`${OWNER}/${giteaTeamName(TEAM)}`);
  assert.ok(team?.members.has(giteaUserName(lastUser)));
  assert.equal((await readAppGitAccess(admin, "app-1", lastUser))?.permission, "read");
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
    const on = view(base);
    assert.equal(on.gitAccountAuth, true);
    assert.equal(on.gitHttpUrl, `https://gitea.example/${OWNER}/tc-app-app-1.git`);
    // The stored values old daemons read are untouched.
    assert.equal(on.gitRemoteUrl, `git@gitea.example:${OWNER}/tc-app-app-1.git`);
    assert.equal(on.gitAuthKind, "gitea_deploy_key");

    const legacy = view({ ...base, git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git" });
    assert.equal(legacy.gitAccountAuth, false);
    assert.equal(legacy.gitHttpUrl, null);

    process.env.GITEA_ACCOUNT_AUTH = "off";
    assert.equal(view(base).gitAccountAuth, false, "turning the switch off sends clients back to SSH");
  } finally {
    if (prev === undefined) delete process.env.GITEA_ACCOUNT_AUTH;
    else process.env.GITEA_ACCOUNT_AUTH = prev;
  }
});

// ── a team's apps in one pass ─────────────────────────────────────────────

test("a team sync asks Gitea about each org, account and team once, however many apps", async () => {
  const apps = ["app-1", "app-2", "app-3"].map((id) =>
    orgApp({ id, visibility: "team", git_remote_url: `git@gitea.example:${OWNER}/tc-app-${id}.git` }),
  );
  const admin = appsSupabase({ seed: { apps, actors, app_member_access: [] } });
  const gitea = fakeGitea();
  await syncTeamAppsToGitea({ gitea, admin }, TEAM);

  const count = (name: string) => gitea.ops.filter((op: any[]) => op[0] === name).length;
  assert.equal(count("ensureOrg"), 1);
  // owner, agent, mate: three accounts, not three per app.
  assert.equal(count("ensureUser"), 3);
  assert.equal(count("addTeamMember"), 3);
  // Every app is still attached to the team and gets its own collaborators.
  assert.equal(gitea.ops.filter((op: any[]) => op[0] === "setTeamRepo" && op[3] === true).length, 3);
  assert.equal(count("setCollaborator"), 3);
});

test("a join waits for its team sync only so long, and the sync still finishes", async () => {
  const admin = appsSupabase({ seed: { apps: [orgApp({ visibility: "team" })], actors, app_member_access: [] } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gitea = fakeGitea();
  const slow = { ...gitea, withOwner: () => ({ ...gitea.withOwner(OWNER), ensureOrg: async () => { await held; } }) };
  const runner = makeGiteaSyncRunner({
    gitea: slow as any,
    enabled: true,
    serviceRoleClient: async () => admin,
    teamWaitMs: 20,
    log: () => {},
  });
  const started = Date.now();
  await runner.team(TEAM);
  assert.ok(Date.now() - started < 1_000, "the request must not wait on a hung Gitea");
  assert.equal(gitea.ops.some((op: any[]) => op[0] === "addTeamMember"), false);

  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gitea.ops.filter((op: any[]) => op[0] === "addTeamMember").length, 3);
});
